package ca.bendavey.pkm;

import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Receives Android share-sheet sends (text/plain) and holds the text
// until the web client collects it once via getSharedText. Cold start:
// the launch intent is the SEND intent. Warm start (singleTask):
// handleOnNewIntent fires. Either way the text is captured exactly
// once — getSharedText clears it after reading.
@CapacitorPlugin(name = "ShareIntent")
public class ShareIntentPlugin extends Plugin {
    private String pendingText = null;

    @Override
    public void load() {
        captureIntent(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        captureIntent(intent);
    }

    private void captureIntent(Intent intent) {
        if (intent == null) return;
        if (!Intent.ACTION_SEND.equals(intent.getAction())) return;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (text == null || text.isEmpty()) return;
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        pendingText = (subject != null && !subject.isEmpty()) ? subject + "\n" + text : text;
    }

    @PluginMethod
    public void getSharedText(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("text", pendingText != null ? pendingText : "");
        pendingText = null;
        call.resolve(ret);
    }
}
