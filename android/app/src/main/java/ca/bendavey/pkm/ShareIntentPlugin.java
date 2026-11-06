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
// are ALSO persisted to SharedPreferences at capture time and the
// getters only PEEK (review 3, item 14): the web client acknowledges
// with clearSharedText/clearSharedImage only after the capture is
// durably saved, so a process death or a failed save no longer loses
// a share, and failures surface instead of being swallowed. Images
// are copied into the app files dir (the same DATA directory the web
// client's Filesystem bridge reads); only the file name crosses to
// JS, which reads, downscales, and files the photo in the Inbox.
// Cold start: the launch intent is the SEND intent. Warm start
// (singleTask): handleOnNewIntent fires.
@CapacitorPlugin(name = "ShareIntent")
public class ShareIntentPlugin extends Plugin {
    private String pendingText = null;
    private String pendingImage = null;
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
        pendingText = (subject != null && !subject.isEmpty()) ? subject + "\n" + text : text;
        try { prefs().edit().putString("share_text", pendingText).apply(); } catch (Exception e) { /* in-memory copy still held */ }
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
            pendingImage = out.getName();
            try { prefs().edit().putString("share_image", pendingImage).apply(); } catch (Exception e) { /* in-memory copy still held */ }
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

    // Peek only (review 3, item 14): the value survives until the
    // web client acknowledges a durable capture via the clear*
    // methods below. Falls back to the persisted copy so a share
    // that arrived before a process restart is still delivered.
    @PluginMethod
    public void getSharedText(PluginCall call) {
        String v = pendingText;
        if (v == null) { try { v = prefs().getString("share_text", ""); } catch (Exception e) { v = ""; } }
        JSObject ret = new JSObject();
        ret.put("text", v != null ? v : "");
        call.resolve(ret);
    }

    @PluginMethod
    public void clearSharedText(PluginCall call) {
        pendingText = null;
        try { prefs().edit().remove("share_text").apply(); } catch (Exception e) { /* ignore */ }
        call.resolve();
    }

    @PluginMethod
    public void getSharedImage(PluginCall call) {
        String v = pendingImage;
        if (v == null) { try { v = prefs().getString("share_image", ""); } catch (Exception e) { v = ""; } }
        JSObject ret = new JSObject();
        ret.put("file", v != null ? v : "");
        call.resolve(ret);
    }

    @PluginMethod
    public void clearSharedImage(PluginCall call) {
        pendingImage = null;
        try { prefs().edit().remove("share_image").apply(); } catch (Exception e) { /* ignore */ }
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
