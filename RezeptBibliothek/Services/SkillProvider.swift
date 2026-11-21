import Foundation

/// Lädt den Skill aus dem Mistral Studio (API) und fällt bei Netzwerkproblemen
/// auf die im App-Bundle eingebettete Kopie zurück.
enum SkillProvider {
    static let fallbackResourceName = "FallbackSkill"
    static let fallbackDescription = "Verwende diesen Skill, wenn der Nutzer ein Rezept für den Thermomix verlangt."

    static func systemPrompt(for settings: MistralAIService.Settings) async throws -> (prompt: String, source: String) {
        do {
            let skill = try await MistralAIService.fetchSkill(settings: settings)
            let source = skill.version.map { "Mistral Studio, Version \($0)" } ?? "Mistral Studio"
            return (compose(body: skill.body, description: nil), source)
        } catch let error as MistralAIService.AIError {
            if case .missingAPIKey = error { throw error }
            if let fallback = loadFallback(), !fallback.isEmpty {
                return (
                    compose(body: fallback, description: fallbackDescription),
                    "Eingebettete Kopie (Studio nicht erreichbar)"
                )
            }
            throw error
        }
    }

    static func loadFallback() -> String? {
        guard let url = Bundle.main.url(forResource: fallbackResourceName, withExtension: "md") else {
            return nil
        }
        return try? String(contentsOf: url, encoding: .utf8)
    }

    private static func compose(body: String, description: String?) -> String {
        var prompt = ""
        if let description, !description.isEmpty {
            prompt += "# Skill\n\(description)\n\n"
        }
        prompt += body.trimmingCharacters(in: .whitespacesAndNewlines)
        prompt += """


        # Zusatz für die API-Nutzung
        Gib ausschließlich das fertige Rezept als Markdown-Dokument zurück (Rezepttitel als H1).
        Keine Einleitung, keine Erklärung, kein Kommentar außerhalb des Markdowns.
        """
        return prompt
    }
}
