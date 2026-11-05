package ca.bendavey.pkm;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.view.View;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

// Backs the Today widget's scrollable ListView: tasks, the day's
// schedule, and the next family events, all read from the same
// widget.json snapshot the web client writes. Item taps arrive as
// fill-in intents on the provider's template (checkbox = complete
// the task via the pending-done channel; body = open it).
public class WidgetListService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Factory(getApplicationContext());
    }

    static class Item {
        int type; // 0 task, 1 label, 2 schedule, 3 family
        String id = "", text = "", meta = "", time = "";
        boolean overdue = false, done = false;
    }

    static class Factory implements RemoteViewsFactory {
        private final Context ctx;
        private final List<Item> items = new ArrayList<>();

        Factory(Context ctx) { this.ctx = ctx; }

        @Override public void onCreate() { }

        @Override
        public void onDataSetChanged() {
            items.clear();
            Set<String> pendingDone = new HashSet<>();
            try {
                SharedPreferences prefs = ctx.getSharedPreferences("dashben", Context.MODE_PRIVATE);
                String raw = prefs.getString("pending_done", "");
                if (raw != null && !raw.isEmpty()) for (String id : raw.split(",")) if (!id.isEmpty()) pendingDone.add(id);
            } catch (Exception e) { /* overlay is optional */ }
            try {
                File f = new File(ctx.getFilesDir(), "widget.json");
                if (!f.exists()) return;
                JSONObject s = new JSONObject(readFile(f));
                JSONArray rows = s.optJSONArray("rows");
                if (rows != null) {
                    for (int i = 0; i < rows.length(); i++) {
                        JSONObject r = rows.getJSONObject(i);
                        Item it = new Item();
                        it.type = 0;
                        it.id = r.optString("id", "");
                        it.text = r.optString("text", "");
                        it.meta = r.optString("meta", "");
                        it.overdue = "overdue".equals(r.optString("kind"));
                        it.done = pendingDone.contains(it.id);
                        items.add(it);
                    }
                }
                JSONArray sched = s.optJSONArray("schedule");
                if (sched != null && sched.length() > 0) {
                    Item label = new Item(); label.type = 1; label.text = "SCHEDULE"; items.add(label);
                    for (int i = 0; i < sched.length(); i++) {
                        String line = sched.optString(i, "");
                        Item it = new Item(); it.type = 2; it.text = line;
                        String[] seps = { " \u2014 ", " \u2013 ", " - " };
                        for (String sep : seps) {
                            int k = line.indexOf(sep);
                            if (k > 0) { it.time = line.substring(0, k); it.text = line.substring(k + sep.length()); break; }
                        }
                        items.add(it);
                    }
                }
                JSONArray fam = s.optJSONArray("familyList");
                if (fam != null && fam.length() > 0) {
                    Item label = new Item(); label.type = 1; label.text = "UP NEXT"; items.add(label);
                    for (int i = 0; i < fam.length(); i++) {
                        JSONObject e = fam.getJSONObject(i);
                        Item it = new Item(); it.type = 3;
                        it.time = e.optString("when", "");
                        it.text = e.optString("title", "");
                        items.add(it);
                    }
                }
            } catch (Exception e) { /* empty list renders the empty view */ }
        }

        private static String readFile(File f) throws Exception {
            FileInputStream in = new FileInputStream(f);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            in.close();
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }

        @Override public void onDestroy() { items.clear(); }
        @Override public int getCount() { return items.size(); }
        @Override public long getItemId(int position) { return position; }
        @Override public boolean hasStableIds() { return false; }
        @Override public int getViewTypeCount() { return 4; }

        @Override
        public RemoteViews getLoadingView() {
            RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_row_task);
            v.setTextViewText(R.id.w_rtext, "Loading\u2026");
            return v;
        }

        @Override
        public RemoteViews getViewAt(int position) {
            Item it = items.get(position);
            if (it.type == 1) {
                RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_row_label);
                v.setTextViewText(R.id.w_rlabel, it.text);
                return v;
            }
            if (it.type == 2) {
                RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_row_sched);
                v.setTextViewText(R.id.w_rtime, it.time);
                v.setTextViewText(R.id.w_rtext2, it.text);
                v.setOnClickFillInIntent(R.id.w_rroot2, new Intent().putExtra("zone", "open"));
                return v;
            }
            if (it.type == 3) {
                RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_row_sched);
                v.setTextViewText(R.id.w_rtime, it.time);
                v.setTextViewText(R.id.w_rtext2, it.text);
                v.setOnClickFillInIntent(R.id.w_rroot2, new Intent().putExtra("zone", "open"));
                return v;
            }
            RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_row_task);
            v.setTextViewText(R.id.w_rtext, it.text);
            v.setTextColor(R.id.w_rtext, Color.parseColor(it.done ? "#8d857b" : (it.overdue ? "#f2a49b" : "#f5efe6")));
            v.setTextViewText(R.id.w_rmeta, it.meta);
            v.setTextColor(R.id.w_rmeta, Color.parseColor(it.overdue ? "#f2a49b" : "#a89e92"));
            v.setImageViewResource(R.id.w_rcheck, it.done ? R.drawable.widget_check_done : (it.overdue ? R.drawable.widget_check_overdue : R.drawable.widget_check));
            if (!it.done && !it.id.isEmpty()) {
                v.setOnClickFillInIntent(R.id.w_rcheck, new Intent().putExtra("zone", "check").putExtra("id", it.id));
                v.setOnClickFillInIntent(R.id.w_rroot, new Intent().putExtra("zone", "body").putExtra("id", it.id));
            } else {
                v.setOnClickFillInIntent(R.id.w_rroot, new Intent().putExtra("zone", "open"));
            }
            return v;
        }
    }
}
