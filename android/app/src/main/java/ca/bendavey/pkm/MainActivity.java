package ca.bendavey.pkm;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ShareIntentPlugin.class);
        registerPlugin(AppLockPlugin.class);
        registerPlugin(WidgetPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
