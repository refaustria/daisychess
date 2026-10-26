package org.daisychess.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/**
 * Capacitor's App plugin only reports ACTION_VIEW intents as appUrlOpen. A PGN shared with
 * "Share" (ACTION_SEND, EXTRA_STREAM) is rewritten into the equivalent VIEW intent so that it
 * reaches the same web-side handler (platform/openedPgn.ts) as "Open with".
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        setIntent(sendToView(getIntent()));
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(sendToView(intent));
    }

    private static Intent sendToView(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return intent;
        Uri stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (stream == null) return intent;
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(stream);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return intent;
    }
}
