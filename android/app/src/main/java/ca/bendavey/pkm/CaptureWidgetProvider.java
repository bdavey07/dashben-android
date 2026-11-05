package ca.bendavey.pkm;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.widget.RemoteViews;

// Capture widget (M6): three shortcuts that open the app straight
// into the matching FAB action (inbox capture, quick-add task,
// quick note) via the ShareIntent plugin's widget-action channel.
public class CaptureWidgetProvider extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) mgr.updateAppWidget(id, build(context));
    }

    private RemoteViews build(Context ctx) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_capture);
        v.setOnClickPendingIntent(R.id.w_cap_capture, TodayWidgetProvider.pending(ctx, 300, TodayWidgetProvider.openIntent(ctx, "capture", null)));
        v.setOnClickPendingIntent(R.id.w_cap_task, TodayWidgetProvider.pending(ctx, 301, TodayWidgetProvider.openIntent(ctx, "task", null)));
        v.setOnClickPendingIntent(R.id.w_cap_note, TodayWidgetProvider.pending(ctx, 302, TodayWidgetProvider.openIntent(ctx, "note", null)));
        return v;
    }
}
