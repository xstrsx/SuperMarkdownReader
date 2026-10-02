import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.FileSystemOperations
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import javax.inject.Inject

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

/**
 * Copies the cloud-built `web/dist` tree into a generated assets directory.
 *
 * The web bundle is produced by `node scripts/build-web.mjs` (GitHub Actions
 * only) and is intentionally NOT committed: the repository stores sources and a
 * lock file, and one commit + one lock file is enough to rebuild every byte.
 */
abstract class SyncWebAssets : DefaultTask() {

    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sourceDir: DirectoryProperty

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @get:Inject
    abstract val fs: FileSystemOperations

    @TaskAction
    fun sync() {
        val src = sourceDir.get().asFile
        check(src.isDirectory) {
            "web/dist is missing. Run `npm ci --prefix web` and " +
                "`node scripts/build-web.mjs` before building the APK."
        }
        check(File(src, "index.html").isFile) {
            "web/dist/index.html is missing; the web build did not complete."
        }
        val generatedRoot = outputDir.get().asFile
        val dest = generatedRoot.resolve("web")
        fs.delete { delete(dest) }
        fs.copy {
            from(src)
            into(dest)
        }
        // Third-party notices ship inside the APK so the in-app "licences" view
        // works offline.
        val notices = File(src, "../THIRD_PARTY_NOTICES.txt").canonicalFile
        val noticesFallback = File(src, "../../THIRD_PARTY_NOTICES.txt").canonicalFile
        val noticesSource = when {
            notices.isFile -> notices
            noticesFallback.isFile -> noticesFallback
            else -> null
        }
        if (noticesSource != null) {
            fs.copy {
                from(noticesSource)
                into(generatedRoot)
            }
        } else {
            logger.lifecycle("LiteDoc: THIRD_PARTY_NOTICES.txt not found; app notices view will be empty")
        }
    }
}

android {
    namespace = "dev.litedoc.viewer"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "dev.litedoc.viewer"
        minSdk = libs.versions.minSdk.get().toInt()
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = (project.findProperty("litedoc.versionCode") as String? ?: "1").toInt()
        versionName = (project.findProperty("litedoc.versionName") as String? ?: "0.1.0")

        // One universal APK; no native engines are shipped.
        ndk {
            abiFilters.clear()
        }
        resourceConfigurations += listOf("en", "zh")
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            // Never sign here: release signing happens in the dedicated,
            // environment-protected job using apksigner only.
            signingConfig = null
        }
        debug {
            isMinifyEnabled = false
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
            freeCompilerArgs.addAll("-Xjvm-default=all")
        }
    }

    buildFeatures {
        buildConfig = true
        resValues = false
        shaders = false
    }

    // Keep the offline web runtime compressing well; only formats that must be
    // memory-mapped stay uncompressed. Nothing here is memory-mapped.
    androidResources {
        noCompress += listOf<String>()
    }

    packaging {
        resources {
            excludes += setOf(
                "/META-INF/{AL2.0,LGPL2.1}",
                "/META-INF/DEPENDENCIES",
                "/META-INF/LICENSE*",
                "/META-INF/NOTICE*",
                "/META-INF/*.kotlin_module",
                "/kotlin/**",
                "/DebugProbesKt.bin",
                "/*.txt",
                "/*.bin",
            )
            // No fixture, no test data, no vendor manifest for debug symbols.
            excludes += setOf("/fixtures/**", "/reports/**")
        }
        jniLibs {
            useLegacyPackaging = false
        }
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = true
        warningsAsErrors = false
        explainIssues = true
        // Versions are pinned deliberately and refreshed by a separate commit.
        disable += setOf(
            "GradleDependency",
            "AndroidGradlePluginVersion",
            "OldTargetApi",
            "NewerVersionAvailable",
        )
        htmlReport = true
        xmlReport = true
        sarifReport = true
    }

    testOptions {
        unitTests.isIncludeAndroidResources = false
        unitTests.isReturnDefaultValues = false
    }
}

// ---------------------------------------------------------------------------
// Generated web assets
// ---------------------------------------------------------------------------

val webDistDir = rootProject.layout.projectDirectory.dir("web/dist")

val webAssetsProvider = tasks.register<SyncWebAssets>("syncWebAssets") {
    group = "litedoc"
    description = "Copies the cloud-built web/dist tree into Android assets."
    sourceDir.set(webDistDir)
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(
            webAssetsProvider,
            SyncWebAssets::outputDir,
        )
    }
}

// A readable failure for anyone who runs Gradle before the web build.
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }.configureEach {
    doFirst {
        if (!File(webDistDir.asFile, "index.html").isFile) {
            throw GradleException(
                "web/dist/index.html not found. The APK must contain the offline web runtime: " +
                    "run `npm ci --prefix web && node scripts/build-web.mjs` first.",
            )
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.webkit)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.coroutines.android)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
