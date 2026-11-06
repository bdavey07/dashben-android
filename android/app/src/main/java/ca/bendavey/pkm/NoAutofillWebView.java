package ca.bendavey.pkm;

import android.content.Context;
import android.util.AttributeSet;
import android.util.SparseArray;
import android.view.ViewStructure;
import android.view.autofill.AutofillValue;

import com.getcapacitor.CapacitorWebView;

/**
 * A CapacitorWebView that gives the Android autofill service NOTHING:
 * the virtual structure it reports is left empty, and autofill() is a
 * no-op, so password managers (NordPass) never see a field in DashBen.
 * Importance flags alone proved unreliable; an empty structure cannot
 * be misread. Stamp cu (2026-11-04).
 */
public class NoAutofillWebView extends CapacitorWebView {

    public NoAutofillWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
        setImportantForAutofill(IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        // No accessibility importance override (review 3, item 10):
        // NO_HIDE_DESCENDANTS here hid the app from screen readers;
        // the empty autofill structure below is the real suppression.
    }

    @Override
    public void onProvideAutofillVirtualStructure(ViewStructure structure, int flags) {
        // Deliberately empty: report no fields to any autofill service.
    }

    @Override
    public void autofill(SparseArray<AutofillValue> values) {
        // No-op: nothing may be filled into this app programmatically.
    }
}
