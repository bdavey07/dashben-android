package ca.bendavey.pkm;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.view.View;
import android.widget.RemoteViews;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.LinkedHashSet;
import java.util.Locale;

// Today widget (M6): header (weather stat strip + due counts) is
// rendered here from the widget.json snapshot the web client writes;
// the scrollable middle (tasks, schedule, up-next family events) is
// served by WidgetListService. Item taps arrive through the list's
// pending-intent template as WIDGET_ITEM broadcasts: a checkbox tap
// records a pending completion the app drains through its real
// store on next open/sync; a row tap opens the task in the app.
public class TodayWidgetProvider extends AppWidgetProvider {
    static final String ITEM_ACTION = "ca.bendavey.pkm.WIDGET_ITEM";

    @Override
    public void onUpdate(Context context, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) mgr.updateAppWidget(id, build(context, id));
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        super.onReceive(ctx, intent);
        if (!ITEM_ACTION.equals(intent.getAction())) return;
        String zone = intent.getStringExtra("zone");
        String id = intent.getStringExtra("id");
        if ("check".equals(zone) && id != null && !id.isEmpty()) {
            try {
                SharedPreferences prefs = ctx.getSharedPreferences("dashben", Context.MODE_PRIVATE);
                LinkedHashSet<String> set = new LinkedHashSet<>();
                String raw = prefs.getString("pending_done", "");
                if (raw != null && !raw.isEmpty()) for (String x : raw.split(",")) if (!x.isEmpty()) set.add(x);
                set.add(id);
                prefs.edit().putString("pending_done", String.join(",", set)).apply();
                AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
                int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, TodayWidgetProvider.class));
                if (ids.length > 0) mgr.notifyAppWidgetViewDataChanged(ids, R.id.w_list);
            } catch (Exception e) { /* pending overlay is best-effort */ }
        } else if ("body".equals(zone) && id != null && !id.isEmpty()) {
            ctx.startActivity(openIntent(ctx, "task-open", id));
        } else if ("open".equals(zone)) {
            ctx.startActivity(openIntent(ctx, "open", null));
        }
    }

    static Intent openIntent(Context ctx, String action, String taskId) {
        Intent i = new Intent(ctx, MainActivity.class);
        i.setAction("ca.bendavey.pkm.WIDGET");
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (action != null) i.putExtra("dashben_action", action);
        if (taskId != null) {
            i.putExtra("dashben_task", taskId);
            i.setData(Uri.parse("dashben://task/" + taskId));
        }
        return i;
    }

    static PendingIntent pending(Context ctx, int code, Intent i) {
        return PendingIntent.getActivity(ctx, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
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

    private void witness(Context ctx, String note) {
        try {
            java.io.FileOutputStream out = new java.io.FileOutputStream(new File(ctx.getFilesDir(), "widget-provider.txt"));
            out.write(((System.currentTimeMillis()) + " " + note).getBytes(StandardCharsets.UTF_8));
            out.close();
        } catch (Exception e) { /* witness is best-effort */ }
    }

    private RemoteViews build(Context ctx, int appWidgetId) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_today);
        v.setOnClickPendingIntent(R.id.w_root, pending(ctx, 100, openIntent(ctx, "open", null)));
        v.setOnClickPendingIntent(R.id.w_btn_capture, pending(ctx, 400, openIntent(ctx, "capture", null)));
        v.setOnClickPendingIntent(R.id.w_btn_task, pending(ctx, 401, openIntent(ctx, "task", null)));
        v.setOnClickPendingIntent(R.id.w_btn_note, pending(ctx, 402, openIntent(ctx, "note", null)));
        Intent svc = new Intent(ctx, WidgetListService.class);
        svc.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        svc.setData(Uri.parse("dashben://list/" + appWidgetId));
        v.setRemoteAdapter(R.id.w_list, svc);
        v.setEmptyView(R.id.w_list, R.id.w_empty);
        Intent template = new Intent(ctx, TodayWidgetProvider.class);
        template.setAction(ITEM_ACTION);
        template.setData(Uri.parse("dashben://items/" + appWidgetId));
        PendingIntent templatePi = PendingIntent.getBroadcast(ctx, 500 + appWidgetId, template, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
        v.setPendingIntentTemplate(R.id.w_list, templatePi);
        String counts = "Open DashBen to sync";
        String updated = "";
        String seen = "ran, snapshot missing";
        try {
            File f = new File(ctx.getFilesDir(), "widget.json");
            if (f.exists()) {
                JSONObject s = new JSONObject(readFile(f));
                int oc = s.optInt("overdueCount"), tc = s.optInt("todayCount");
                counts = oc > 0 ? ("\u26A0 " + oc + " overdue \u00B7 " + tc + " due today")
                        : (tc > 0 ? (tc + " due today") : "All clear today");
                JSONObject wxo = s.optJSONObject("wx");
                if (wxo != null) {
                    v.setTextViewText(R.id.w_wx_temp, wxo.optString("temp", "\u2014"));
                    v.setTextViewText(R.id.w_wx_feels, wxo.optString("feels", "\u2014"));
                    v.setTextViewText(R.id.w_wx_wind, wxo.optString("wind", "\u2014"));
                    v.setTextViewText(R.id.w_wx_pop, wxo.optString("pop", "\u2014"));
                    v.setTextViewText(R.id.w_wx_psum, wxo.optString("psum", "\u2014"));
                    v.setViewVisibility(R.id.w_wx, View.VISIBLE);
                }
                long at = s.optLong("at", 0);
                if (at > 0) updated = "Updated " + new SimpleDateFormat("h:mm a", Locale.CANADA).format(new Date(at));
                seen = "ran, snapshot found (list v2)";
            }
        } catch (Exception e) { seen = "ran, error: " + e.getMessage(); }
        witness(ctx, seen);
        v.setTextViewText(R.id.w_counts, counts);
        v.setTextViewText(R.id.w_updated, updated);
        return v;
    }
}
