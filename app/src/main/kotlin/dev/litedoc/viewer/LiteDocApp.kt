package dev.litedoc.viewer

import android.app.Application
import dev.litedoc.viewer.settings.ViewerSettings

/**
 * Process-scoped state. Keeping the session orchestrator here (instead of in an
 * Activity) is what lets the Activity be destroyed and recreated without losing
 * the open document or the authorised attachment tree, and it guarantees that no
 * View or WebView reference is ever retained.
 */
class LiteDocApp : Application() {

    lateinit var settings: ViewerSettings
        private set

    lateinit var viewer: ViewerViewModel
        private set

    override fun onCreate() {
        super.onCreate()
        settings = ViewerSettings(this)
        viewer = ViewerViewModel(this)
    }

    override fun onTerminate() {
        viewer.shutdown()
        super.onTerminate()
    }
}
