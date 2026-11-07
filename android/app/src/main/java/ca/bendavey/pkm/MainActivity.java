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
        registerPlugin(SystemBarsPlugin.class);
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
        // NOTE: no IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS here
        // (review 3, item 10): it hid the whole app from screen readers.
        // Autofill suppression above uses the autofill flags + the
        // WebView's empty autofill structure, not accessibility.
        WidgetPlugin.poke(this);
    }

    // Back button (stamp eu): the web client closes its top-most layer
    // first (autocomplete, lightbox, palette, + menu, popup — saving it
    // like a backdrop tap — then the drawer, then a full item page).
    // Only when it reports nothing left to close does Android's own
    // back run and leave the app.
    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        android.webkit.WebView wv = null;
        try { wv = getBridge().getWebView(); } catch (Exception e) { /* bridge not ready */ }
        if (wv == null) { super.onBackPressed(); return; }
        wv.evaluateJavascript("(function(){try{return window.__dashbenBack&&window.__dashbenBack()?'1':'0'}catch(e){return '0'}})()", (value) -> {
            if (!"\"1\"".equals(value)) runOnUiThread(MainActivity.super::onBackPressed);
        });
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
