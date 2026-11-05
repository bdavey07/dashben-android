package ca.bendavey.pkm;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Lets the web client ask for an immediate widget redraw right
// after it writes a fresh widget.json snapshot, instead of waiting
// for the system's 30-minute widget cadence.
@CapacitorPlugin(name = "WidgetBridge")
public class WidgetPlugin extends Plugin {
    @PluginMethod
    public void refresh(PluginCall call) {
        Context ctx = getContext();
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] todayIds = mgr.getAppWidgetIds(new ComponentName(ctx, TodayWidgetProvider.class));
        if (todayIds.length > 0) new TodayWidgetProvider().onUpdate(ctx, mgr, todayIds);
        int[] capIds = mgr.getAppWidgetIds(new ComponentName(ctx, CaptureWidgetProvider.class));
        if (capIds.length > 0) new CaptureWidgetProvider().onUpdate(ctx, mgr, capIds);
        call.resolve();
    }
}
