// LiteDoc root build file.
//
// This project is built ONLY in GitHub Actions (see .github/workflows/).
// Local WSL is used for source edits and non-Android source checks only.

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
}

// Dependency locking + verification metadata are generated once by
// .github/workflows/bootstrap.yml (a Gradle run is required to produce them)
// and committed afterwards. Locking is therefore only activated when the
// generated lock state is present, so a fresh checkout that has not yet run
// bootstrap still builds.
val lockStatePresent = file("gradle.lockfile").exists() ||
    file("app/gradle.lockfile").exists() ||
    file("gradle/verification-metadata.xml").exists()

if (lockStatePresent) {
    allprojects {
        dependencyLocking {
            lockAllConfigurations()
        }
    }
    // Gradle picks up gradle/verification-metadata.xml automatically; there is no
    // project-level DSL for it, so nothing else is configured here.
    logger.lifecycle("LiteDoc: dependency lock state detected, locking enabled.")
} else {
    logger.lifecycle("LiteDoc: no dependency lock state committed yet; run bootstrap.yml.")
}

// Resolve every resolvable configuration so `--write-locks` can produce a
// complete set of lock files for the real dependency graph.
tasks.register("resolveAndLockAll") {
    notCompatibleWithConfigurationCache("Resolves all configurations in one pass")
    doFirst {
        require(gradle.startParameter.isWriteDependencyLocks) {
            "Run with --write-locks to rewrite the dependency lock state."
        }
    }
    doLast {
        allprojects {
            configurations
                .filter { it.isCanBeResolved }
                .forEach { cfg ->
                    runCatching {
                        cfg.resolvedConfiguration.lenientConfiguration.artifacts
                    }
                }
        }
    }
}
