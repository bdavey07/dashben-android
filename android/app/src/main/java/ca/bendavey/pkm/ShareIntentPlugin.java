package ca.bendavey.pkm;

import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;

// Receives Android share-sheet sends (text/plain and image/*) and
// holds them until the web client collects each exactly once. Shares
// are persisted to SharedPreferences at capture time as a durable
// QUEUE with unique ids (review 5, item 5): the old single-slot
// design let an acknowledgement for share A delete a share B that
// had arrived while A was being saved. The getters PEEK the oldest
// entry and return its id; the web client acknowledges THAT ID
// (clearSharedText/clearSharedImage) only after the capture is
// durably saved, so a process death or a failed save loses nothing,
// a late ack can only ever remove its own entry, and the client can
// make capture idempotent per id. Legacy single-slot values from
// earlier builds are adopted into the queue on first read. Images
// are copied into the app files dir (the same DATA directory the web
// client's Filesystem bridge reads); only the file name crosses to
// JS, which reads, downscales, and files the photo in the Inbox.
// Cold start: the launch intent is the SEND intent. Warm start
// (singleTask): handleOnNewIntent fires.
@CapacitorPlugin(name = "ShareIntent")
public class ShareIntentPlugin extends Plugin {
    private String pendingWidgetAction = null;
    private String pendingWidgetTask = null;

    @Override
    public void load() {
        captureIntent(getActivity().getIntent());
        captureWidgetIntent(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        captureIntent(intent);
        captureWidgetIntent(intent);
    }

    // Widget taps (M6) arrive as MainActivity intents carrying
    // dashben_action / dashben_task extras; held until the web
    // client collects them exactly once.
    private void captureWidgetIntent(Intent intent) {
        if (intent == null) return;
        String act = intent.getStringExtra("dashben_action");
        if (act == null || act.isEmpty()) return;
        pendingWidgetAction = act;
        pendingWidgetTask = intent.getStringExtra("dashben_task");
    }

    private void captureIntent(Intent intent) {
        if (intent == null) return;
        if (!Intent.ACTION_SEND.equals(intent.getAction())) return;
        String type = intent.getType();
        if (type != null && type.startsWith("image/")) {
            Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri != null) copySharedImage(uri);
            return;
        }
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (text == null || text.isEmpty()) return;
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        String full = (subject != null && !subject.isEmpty()) ? subject + "\n" + text : text;
        enqueueText(full);
    }

    // --- Durable share queues (review 5, item 5) ---
    // Each queue is a JSON array in SharedPreferences of
    // {"id": ..., "text"|"file": ..., "ts": ...}, oldest first.
    private synchronized org.json.JSONArray readQueue(String key) {
        try {
            String raw = prefs().getString(key, "");
            if (raw != null && !raw.isEmpty()) return new org.json.JSONArray(raw);
        } catch (Exception e) { /* fall through to empty */ }
        return new org.json.JSONArray();
    }

    private synchronized void writeQueue(String key, org.json.JSONArray q) {
        try { prefs().edit().putString(key, q.toString()).apply(); } catch (Exception e) { /* best effort */ }
    }

    private void enqueueText(String text) {
        org.json.JSONArray q = readQueue("share_text_queue");
        try {
            org.json.JSONObject e = new org.json.JSONObject();
            e.put("id", java.util.UUID.randomUUID().toString());
            e.put("text", text);
            e.put("ts", System.currentTimeMillis());
            q.put(e);
        } catch (Exception ex) { return; }
        writeQueue("share_text_queue", q);
    }

    private void enqueueImage(String file) {
        org.json.JSONArray q = readQueue("share_image_queue");
        try {
            org.json.JSONObject e = new org.json.JSONObject();
            e.put("id", java.util.UUID.randomUUID().toString());
            e.put("file", file);
            e.put("ts", System.currentTimeMillis());
            q.put(e);
        } catch (Exception ex) { return; }
        writeQueue("share_image_queue", q);
    }

    // Adopt a legacy single-slot value (pre-queue builds) as a queue
    // entry with a stable legacy id, so an unacknowledged share from
    // before the upgrade is still delivered — exactly once.
    private synchronized org.json.JSONArray queueWithLegacy(String queueKey, String legacyKey, String field) {
        org.json.JSONArray q = readQueue(queueKey);
        try {
            String legacy = prefs().getString(legacyKey, "");
            if (legacy != null && !legacy.isEmpty()) {
                org.json.JSONObject e = new org.json.JSONObject();
                e.put("id", "legacy-" + legacyKey);
                e.put(field, legacy);
                e.put("ts", 0);
                org.json.JSONArray merged = new org.json.JSONArray();
                merged.put(e);
                for (int i = 0; i < q.length(); i++) merged.put(q.get(i));
                q = merged;
                prefs().edit().remove(legacyKey).apply();
                writeQueue(queueKey, q);
            }
        } catch (Exception e) { /* queue as-is */ }
        return q;
    }

    private synchronized org.json.JSONObject peekQueue(String queueKey, String legacyKey, String field) {
        org.json.JSONArray q = queueWithLegacy(queueKey, legacyKey, field);
        if (q.length() == 0) return null;
        try { return q.getJSONObject(0); } catch (Exception e) { return null; }
    }

    private synchronized void ackQueue(String queueKey, String id) {
        if (id == null || id.isEmpty()) return;
        org.json.JSONArray q = readQueue(queueKey);
        org.json.JSONArray kept = new org.json.JSONArray();
        try {
            for (int i = 0; i < q.length(); i++) {
                org.json.JSONObject e = q.getJSONObject(i);
                if (!id.equals(e.optString("id"))) kept.put(e);
            }
        } catch (Exception e) { return; }
        writeQueue(queueKey, kept);
    }

    private android.content.SharedPreferences prefs() {
        return getContext().getSharedPreferences("dashben", android.content.Context.MODE_PRIVATE);
    }

    private void copySharedImage(Uri uri) {
        try {
            File out = new File(getContext().getFilesDir(), "shared-image-" + System.currentTimeMillis() + ".jpg");
            InputStream in = getContext().getContentResolver().openInputStream(uri);
            if (in == null) return;
            FileOutputStream fos = new FileOutputStream(out);
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) fos.write(buf, 0, n);
            fos.close();
            in.close();
            enqueueImage(out.getName());
        } catch (Exception e) {
            // Share capture is best-effort; a failed copy drops the share.
        }
    }

    @PluginMethod
    public void getWidgetAction(PluginCall call) {
        String act = pendingWidgetAction;
        String task = pendingWidgetTask;
        pendingWidgetAction = null;
        pendingWidgetTask = null;
        if (act == null || act.isEmpty()) {
            // Fall back to the SharedPreferences stash MainActivity
            // writes on every widget-tap intent.
            try {
                android.content.SharedPreferences prefs = getContext().getSharedPreferences("dashben", android.content.Context.MODE_PRIVATE);
                act = prefs.getString("widget_action", "");
                task = prefs.getString("widget_task", "");
                prefs.edit().remove("widget_action").remove("widget_task").apply();
            } catch (Exception e) { /* in-memory channel only */ }
        }
        JSObject ret = new JSObject();
        ret.put("action", act != null ? act : "");
        ret.put("taskId", task != null ? task : "");
        call.resolve(ret);
    }

    @PluginMethod
    public void getPendingDone(PluginCall call) {
        JSObject ret = new JSObject();
        org.json.JSONArray arr = new org.json.JSONArray();
        try {
            android.content.SharedPreferences prefs = getContext().getSharedPreferences("dashben", android.content.Context.MODE_PRIVATE);
            String raw = prefs.getString("pending_done", "");
            if (raw != null && !raw.isEmpty()) for (String id : raw.split(",")) if (!id.isEmpty()) arr.put(id);
        } catch (Exception e) { /* none pending */ }
        ret.put("ids", arr);
        call.resolve(ret);
    }

    @PluginMethod
    public void clearPendingDone(PluginCall call) {
        try { getContext().getSharedPreferences("dashben", android.content.Context.MODE_PRIVATE).edit().remove("pending_done").apply(); } catch (Exception e) { /* ignore */ }
        call.resolve();
    }

    // Peek the OLDEST queued share and return it WITH its id
    // (review 5, item 5): the entry survives until the web client
    // acknowledges that exact id after a durable capture.
    @PluginMethod
    public void getSharedText(PluginCall call) {
        org.json.JSONObject e = peekQueue("share_text_queue", "share_text", "text");
        JSObject ret = new JSObject();
        ret.put("id", e != null ? e.optString("id") : "");
        ret.put("text", e != null ? e.optString("text") : "");
        call.resolve(ret);
    }

    @PluginMethod
    public void clearSharedText(PluginCall call) {
        ackQueue("share_text_queue", call.getString("id", ""));
        call.resolve();
    }

    @PluginMethod
    public void getSharedImage(PluginCall call) {
        org.json.JSONObject e = peekQueue("share_image_queue", "share_image", "file");
        JSObject ret = new JSObject();
        ret.put("id", e != null ? e.optString("id") : "");
        ret.put("file", e != null ? e.optString("file") : "");
        call.resolve(ret);
    }

    @PluginMethod
    public void clearSharedImage(PluginCall call) {
        ackQueue("share_image_queue", call.getString("id", ""));
        call.resolve();
    }

    // Per-id acknowledgement for widget completions (review 3, item
    // 12): the web client clears exactly the ids it applied and
    // durably saved; anything else stays queued for the next drain.
    @PluginMethod
    public void clearPendingDoneIds(PluginCall call) {
        try {
            org.json.JSONArray ids = call.getArray("ids");
            if (ids == null || ids.length() == 0) { call.resolve(); return; }
            java.util.HashSet<String> done = new java.util.HashSet<>();
            for (int i = 0; i < ids.length(); i++) done.add(ids.getString(i));
            android.content.SharedPreferences prefs = prefs();
            java.util.LinkedHashSet<String> keep = new java.util.LinkedHashSet<>();
            String raw = prefs.getString("pending_done", "");
            if (raw != null && !raw.isEmpty()) for (String x : raw.split(",")) if (!x.isEmpty() && !done.contains(x)) keep.add(x);
            StringBuilder sb = new StringBuilder();
            String rawAt = prefs.getString("pending_done_at", "");
            if (rawAt != null && !rawAt.isEmpty()) {
                for (String pair : rawAt.split(",")) {
                    int colon = pair.lastIndexOf(':');
                    if (colon > 0 && !done.contains(pair.substring(0, colon))) {
                        if (sb.length() > 0) sb.append(',');
                        sb.append(pair);
                    }
                }
            }
            prefs.edit().putString("pending_done", String.join(",", keep)).putString("pending_done_at", sb.toString()).apply();
        } catch (Exception e) { /* ids stay queued; next drain retries */ }
        call.resolve();
    }
}
