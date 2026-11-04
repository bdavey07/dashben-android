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
// holds them until the web client collects each exactly once. Images
// are copied into the app files dir (the same DATA directory the web
// client's Filesystem bridge reads); only the file name crosses to
// JS, which reads, downscales, and files the photo in the Inbox.
// Cold start: the launch intent is the SEND intent. Warm start
// (singleTask): handleOnNewIntent fires.
@CapacitorPlugin(name = "ShareIntent")
public class ShareIntentPlugin extends Plugin {
    private String pendingText = null;
    private String pendingImage = null;

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
        } catch (Exception e) {
            // Share capture is best-effort; a failed copy drops the share.
        }
    }

    @PluginMethod
    public void getSharedText(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("text", pendingText != null ? pendingText : "");
        pendingText = null;
        call.resolve(ret);
    }

    @PluginMethod
    public void getSharedImage(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("file", pendingImage != null ? pendingImage : "");
        pendingImage = null;
        call.resolve(ret);
    }
}
