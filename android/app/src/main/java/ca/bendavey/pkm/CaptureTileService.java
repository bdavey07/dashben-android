package ca.bendavey.pkm;

import android.content.Intent;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;
import androidx.annotation.RequiresApi;

// Quick Settings tile (stamp eu): one tap from the notification shade
// opens DashBen's capture sheet, through the same dashben_action
// extra the widgets and app shortcuts use.
@RequiresApi(api = Build.VERSION_CODES.N)
public class CaptureTileService extends TileService {
    @Override
    public void onStartListening() {
        Tile tile = getQsTile();
        if (tile == null) return;
        tile.setState(Tile.STATE_INACTIVE);
        tile.updateTile();
    }

    @Override
    public void onClick() {
        Intent i = new Intent(this, MainActivity.class);
        i.setAction("ca.bendavey.pkm.WIDGET");
        i.putExtra("dashben_action", "capture");
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        startActivityAndCollapse(i);
    }
}
