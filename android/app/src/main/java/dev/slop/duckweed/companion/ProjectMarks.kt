package dev.slop.duckweed.companion

data class ProjectMarkIdentity(
    val key: String,
    val name: String,
)

/** Stable two-character marks that remain unique within the current project list. */
object ProjectMarks {
    private const val ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"

    fun assign(projects: List<ProjectMarkIdentity>): Map<String, String> {
        val used = mutableSetOf<String>()
        val result = mutableMapOf<String, String>()
        projects.distinctBy(ProjectMarkIdentity::key).sortedBy(ProjectMarkIdentity::key).forEach { project ->
            val seed = stableHash(project.key)
            val lead = project.name.firstOrNull(Char::isLetterOrDigit)?.uppercaseChar() ?: 'P'
            val preferred = buildString {
                append(lead)
                append(ALPHABET[(seed % ALPHABET.length).toInt()])
            }
            val mark = if (used.add(preferred)) {
                preferred
            } else {
                allMarks(seed).first { used.add(it) }
            }
            result[project.key] = mark
        }
        return result
    }

    private fun allMarks(seed: Long): Sequence<String> = sequence {
        val capacity = ALPHABET.length * ALPHABET.length
        for (offset in 0 until capacity) {
            val value = ((seed + offset) % capacity).toInt()
            yield("${ALPHABET[value / ALPHABET.length]}${ALPHABET[value % ALPHABET.length]}")
        }
    }

    private fun stableHash(value: String): Long {
        var hash = 2_166_136_261L
        value.forEach { character ->
            hash = ((hash xor character.code.toLong()) * 16_777_619L) and 0xffff_ffffL
        }
        return hash
    }
}
