package ca.bendavey.pkm;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.view.View;
import android.widget.RemoteViews;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

// Today widget (M6): renders the widget.json snapshot the web client
// writes into the app files dir after every sync — overdue + due
// today tasks, the next family event, and the weather line. Read
// only: taps open the app (a task tap opens that task's popup via
// the ShareIntent plugin's widget-action channel).
public class TodayWidgetProvider extends AppWidgetProvider {
    static final int[] ROW_IDS = { R.id.w_row1, R.id.w_row2, R.id.w_row3, R.id.w_row4, R.id.w_row5, R.id.w_row6 };
    static final int[] ROWC_IDS = { R.id.w_rowc1, R.id.w_rowc2, R.id.w_rowc3, R.id.w_rowc4, R.id.w_rowc5, R.id.w_rowc6 };
    static final int[] META_IDS = { R.id.w_meta1, R.id.w_meta2, R.id.w_meta3, R.id.w_meta4, R.id.w_meta5, R.id.w_meta6 };
    static final int[] CHECK_IDS = { R.id.w_check1, R.id.w_check2, R.id.w_check3, R.id.w_check4, R.id.w_check5, R.id.w_check6 };
    static final int[] SROWC_IDS = { R.id.w_srowc1, R.id.w_srowc2, R.id.w_srowc3, R.id.w_srowc4 };
    static final int[] STIME_IDS = { R.id.w_stime1, R.id.w_stime2, R.id.w_stime3, R.id.w_stime4 };
    static final int[] STEXT_IDS = { R.id.w_stext1, R.id.w_stext2, R.id.w_stext3, R.id.w_stext4 };

    @Override
    public void onUpdate(Context context, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) mgr.updateAppWidget(id, build(context));
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

    private RemoteViews build(Context ctx) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_today);
        v.setOnClickPendingIntent(R.id.w_root, pending(ctx, 100, openIntent(ctx, "open", null)));
        String counts = "Open DashBen to sync";
        String seen = "ran, snapshot missing";
        String weather = "", family = "", updated = "";
        int shown = 0;
        try {
            File f = new File(ctx.getFilesDir(), "widget.json");
            if (f.exists()) {
                JSONObject s = new JSONObject(readFile(f));
                int oc = s.optInt("overdueCount"), tc = s.optInt("todayCount");
                counts = oc > 0 ? ("\u26A0 " + oc + " overdue \u00B7 " + tc + " due today")
                        : (tc > 0 ? (tc + " due today") : "All clear today");
                weather = s.optString("weather", "");
                JSONObject wxo = s.optJSONObject("wx");
                if (wxo != null) {
                    v.setTextViewText(R.id.w_wx_temp, wxo.optString("temp", "\u2014"));
                    v.setTextViewText(R.id.w_wx_feels, wxo.optString("feels", "\u2014"));
                    v.setTextViewText(R.id.w_wx_wind, wxo.optString("wind", "\u2014"));
                    v.setTextViewText(R.id.w_wx_pop, wxo.optString("pop", "\u2014"));
                    v.setTextViewText(R.id.w_wx_psum, wxo.optString("psum", "\u2014"));
                    v.setViewVisibility(R.id.w_wx, View.VISIBLE);
                }
                JSONObject fam = s.optJSONObject("family");
                if (fam != null) family = "\uD83D\uDCC5 " + fam.optString("when", "") + " \u2014 " + fam.optString("title", "");
                JSONArray rows = s.optJSONArray("rows");
                if (rows != null) {
                    for (int i = 0; i < rows.length() && i < ROW_IDS.length; i++) {
                        JSONObject r = rows.getJSONObject(i);
                        boolean od = "overdue".equals(r.optString("kind"));
                        v.setTextViewText(ROW_IDS[i], r.optString("text", ""));
                        v.setTextColor(ROW_IDS[i], Color.parseColor(od ? "#f2a49b" : "#f5efe6"));
                        v.setTextViewText(META_IDS[i], r.optString("meta", ""));
                        v.setTextColor(META_IDS[i], Color.parseColor(od ? "#f2a49b" : "#a89e92"));
                        v.setImageViewResource(CHECK_IDS[i], od ? R.drawable.widget_check_overdue : R.drawable.widget_check);
                        v.setViewVisibility(ROWC_IDS[i], View.VISIBLE);
                        String rid = r.optString("id", "");
                        if (!rid.isEmpty()) v.setOnClickPendingIntent(ROWC_IDS[i], pending(ctx, 200 + i, openIntent(ctx, "task-open", rid)));
                        shown++;
                    }
                }
                seen = "ran, snapshot found, rows=" + shown + ", overdue=" + oc + ", today=" + tc;
                long at = s.optLong("at", 0);
                if (at > 0) updated = "Updated " + new SimpleDateFormat("h:mm a", Locale.CANADA).format(new Date(at));
            }
        } catch (Exception e) { seen = "ran, error: " + e.getMessage(); }
        witness(ctx, seen);
        for (int i = shown; i < ROWC_IDS.length; i++) v.setViewVisibility(ROWC_IDS[i], View.GONE);
        int sShown = 0;
        try {
            File f2 = new File(ctx.getFilesDir(), "widget.json");
            if (f2.exists()) {
                JSONArray sched = new JSONObject(readFile(f2)).optJSONArray("schedule");
                if (sched != null) {
                    for (int i = 0; i < sched.length() && i < SROWC_IDS.length; i++) {
                        String line = sched.optString(i, "");
                        String time = "", text = line;
                        String[] seps = { " \u2014 ", " \u2013 ", " - " };
                        for (String sep : seps) {
                            int k = line.indexOf(sep);
                            if (k > 0) { time = line.substring(0, k); text = line.substring(k + sep.length()); break; }
                        }
                        v.setTextViewText(STIME_IDS[i], time);
                        v.setTextViewText(STEXT_IDS[i], text);
                        v.setViewVisibility(SROWC_IDS[i], View.VISIBLE);
                        sShown++;
                    }
                }
            }
        } catch (Exception e) { /* schedule is optional */ }
        for (int i = sShown; i < SROWC_IDS.length; i++) v.setViewVisibility(SROWC_IDS[i], View.GONE);
        v.setViewVisibility(R.id.w_sched_label, sShown > 0 ? View.VISIBLE : View.GONE);
        v.setTextViewText(R.id.w_counts, counts);
        v.setOnClickPendingIntent(R.id.w_btn_capture, pending(ctx, 400, openIntent(ctx, "capture", null)));
        v.setOnClickPendingIntent(R.id.w_btn_task, pending(ctx, 401, openIntent(ctx, "task", null)));
        v.setOnClickPendingIntent(R.id.w_btn_note, pending(ctx, 402, openIntent(ctx, "note", null)));
        v.setTextViewText(R.id.w_family, family);
        v.setViewVisibility(R.id.w_family, family.isEmpty() ? View.GONE : View.VISIBLE);
        v.setTextViewText(R.id.w_updated, updated);
        return v;
    }
}
