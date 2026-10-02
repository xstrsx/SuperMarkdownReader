package dev.litedoc.viewer

/**
 * Two explicit palettes. The system night mode selects the default, and an
 * explicit light/dark choice overrides it at runtime without recreating the
 * activity (which would lose the reading position).
 */
enum class ViewerPalette(
    val window: Int,
    val toolbar: Int,
    val foreground: Int,
    val accent: Int,
    val dark: Boolean,
) {
    LIGHT(
        window = 0xFFFBFBFF.toInt(),
        toolbar = 0xFFF2F3F7.toInt(),
        foreground = 0xFF1B1B1F.toInt(),
        accent = 0xFF3B6EA5.toInt(),
        dark = false,
    ),
    DARK(
        window = 0xFF121316.toInt(),
        toolbar = 0xFF1C1D21.toInt(),
        foreground = 0xFFE6E6EA.toInt(),
        accent = 0xFF8AB4F8.toInt(),
        dark = true,
    ),
    ;

    companion object {
        fun forDark(dark: Boolean): ViewerPalette = if (dark) DARK else LIGHT
    }
}
