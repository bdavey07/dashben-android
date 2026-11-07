package ca.bendavey.pkm;

import android.graphics.Color;
import android.os.Build;
import android.view.View;
import android.view.Window;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// System bar colours (stamp eu): the web client reports its header
// colour and whether the theme is light, so the status and
// navigation bars match the app instead of staying black.
@CapacitorPlugin(name = "SystemBars")
public class SystemBarsPlugin extends Plugin {
    @PluginMethod
    public void set(PluginCall call) {
        final String hex = call.getString("color", "#121318");
        final boolean light = Boolean.TRUE.equals(call.getBoolean("light", false));
        getActivity().runOnUiThread(() -> {
            try {
                int color = Color.parseColor(hex);
                Window w = getActivity().getWindow();
                w.setStatusBarColor(color);
                w.setNavigationBarColor(color);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    View decor = w.getDecorView();
                    int flags = decor.getSystemUiVisibility();
                    flags = light ? (flags | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR) : (flags & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        flags = light ? (flags | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR) : (flags & ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
                    }
                    decor.setSystemUiVisibility(flags);
                }
                call.resolve();
            } catch (Exception e) {
                call.reject("Could not set system bar colours: " + e.getMessage());
            }
        });
    }
}
