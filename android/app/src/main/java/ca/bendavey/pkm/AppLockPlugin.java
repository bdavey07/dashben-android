package ca.bendavey.pkm;

import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// App lock (stamp ca): framework BiometricPrompt (Android 11+),
// fingerprint with device-credential fallback. No androidx needed.
@CapacitorPlugin(name = "AppLock")
public class AppLockPlugin extends Plugin {
    private PluginCall savedCall;

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        boolean avail = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            BiometricManager bm = getContext().getSystemService(BiometricManager.class);
            if (bm != null) {
                int res = bm.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG
                        | BiometricManager.Authenticators.DEVICE_CREDENTIAL);
                avail = res == BiometricManager.BIOMETRIC_SUCCESS;
            }
        }
        ret.put("available", avail);
        call.resolve(ret);
    }

    @PluginMethod
    public void authenticate(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            call.reject("App lock needs Android 11 or newer");
            return;
        }
        savedCall = call;
        getActivity().runOnUiThread(() -> {
            BiometricPrompt prompt = new BiometricPrompt.Builder(getContext())
                    .setTitle("DashBen is locked")
                    .setSubtitle("Unlock with fingerprint or device PIN")
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG
                            | BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                    .setConfirmationRequired(false)
                    .build();
            prompt.authenticate(new CancellationSignal(), getContext().getMainExecutor(),
                    new BiometricPrompt.AuthenticationCallback() {
                        @Override
                        public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                            finish(true, null);
                        }

                        @Override
                        public void onAuthenticationError(int errorCode, CharSequence errString) {
                            finish(false, errString != null ? errString.toString() : "Unlock cancelled");
                        }
                    });
        });
    }

    private void finish(boolean ok, String message) {
        if (savedCall == null) return;
        JSObject ret = new JSObject();
        ret.put("ok", ok);
        if (message != null) ret.put("message", message);
        savedCall.resolve(ret);
        savedCall = null;
    }
}
