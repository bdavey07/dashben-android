package ca.bendavey.pkm;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ShareIntentPlugin.class);
        registerPlugin(AppLockPlugin.class);
        registerPlugin(WidgetPlugin.class);
        super.onCreate(savedInstanceState);
        // Ben: password managers must not offer autofill anywhere in the app.
        try { getBridge().getWebView().setImportantForAutofill(android.view.View.IMPORTANT_FOR_AUTOFILL_NO); } catch (Exception e) { /* best effort */ }
        try { getWindow().getDecorView().setImportantForAutofill(android.view.View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS); } catch (Exception e) { /* best effort */ }
        stashWidgetAction(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        stashWidgetAction(intent);
    }

    @Override
    public void onResume() {
        super.onResume();
        // Re-assert the autofill exclusion once the WebView certainly exists.
        try { getBridge().getWebView().setImportantForAutofill(android.view.View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS); } catch (Exception e) { /* best effort */ }
        try { getBridge().getWebView().setImportantForAccessibility(android.view.View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS); } catch (Exception e) { /* best effort */ }
        WidgetPlugin.poke(this);
    }

    // Belt-and-braces copy of the widget-tap extras in
    // SharedPreferences, so the action survives even if the
    // plugin's in-memory capture is missed.
    private void stashWidgetAction(Intent intent) {
        if (intent == null) return;
        String act = intent.getStringExtra("dashben_action");
        if (act == null || act.isEmpty()) return;
        String task = intent.getStringExtra("dashben_task");
        getSharedPreferences("dashben", MODE_PRIVATE).edit()
                .putString("widget_action", act)
                .putString("widget_task", task != null ? task : "")
                .putLong("widget_at", System.currentTimeMillis())
                .apply();
    }
}
