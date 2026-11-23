import Foundation

struct MistralAIService {
    static let baseURL = URL(string: "https://api.mistral.ai")!
    static let defaultModel = "mistral-large-latest"

    struct Settings: Sendable {
        var apiKey: String
        var model: String
        var skillName: String
        var skillAlias: String

        var effectiveModel: String {
            model.trimmingCharacters(in: .whitespaces).isEmpty ? MistralAIService.defaultModel : model
        }
    }

    enum AIError: LocalizedError {
        case missingAPIKey
        case network(String)
        case http(Int, String)
        case noContent
        case decoding
        case invalidResponse(String)

        var errorDescription: String? {
            switch self {
            case .missingAPIKey:
                return "Kein Mistral-API-Key hinterlegt. Bitte in den Einstellungen eintragen."
            case .network(let message):
                return "Netzwerkfehler: \(message)"
            case .http(let code, let message):
                return "API-Fehler (HTTP \(code)): \(message)"
            case .noContent:
                return "Die KI hat keine Antwort geliefert."
            case .decoding:
                return "Die Antwort der API konnte nicht gelesen werden."
            case .invalidResponse(let preview):
                return "Antwort der API nicht lesbar. Anfang: \(String(preview.prefix(300)))"
            }
        }
    }

    // MARK: - Skill aus dem Mistral Studio abrufen (GET /v2/skills/{skill_id}?alias=...)

    struct SkillResponse: Decodable {
        struct Definition: Decodable {
            let description: String?
            let body: String?
        }
        let name: String?
        let version: Int?
        let definition: Definition?
    }

    static func fetchSkill(settings: Settings) async throws -> (body: String, version: Int?) {
        guard !settings.apiKey.trimmingCharacters(in: .whitespaces).isEmpty else {
            throw AIError.missingAPIKey
        }
        var components = URLComponents(
            url: baseURL.appendingPathComponent("v2/skills/skill:\(settings.skillName)"),
            resolvingAgainstBaseURL: false
        )!
        if !settings.skillAlias.trimmingCharacters(in: .whitespaces).isEmpty {
            components.queryItems = [URLQueryItem(name: "alias", value: settings.skillAlias)]
        }
        var request = URLRequest(url: components.url!)
        request.httpMethod = "GET"
        request.timeoutInterval = 30
        request.setValue("Bearer \(settings.apiKey)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw AIError.network("Ungültige Server-Antwort.")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw AIError.http(http.statusCode, Self.errorMessage(from: data))
        }
        let skill: SkillResponse
        do {
            skill = try JSONDecoder().decode(SkillResponse.self, from: data)
        } catch {
            throw AIError.invalidResponse(Self.errorMessage(from: data))
        }
        guard let body = skill.definition?.body, !body.isEmpty else {
            throw AIError.invalidResponse("definition.body fehlt. Anfang: " + Self.errorMessage(from: data).prefix(300))
        }
        return (body, skill.version)
    }

    // MARK: - Chat Completion (POST /v1/chat/completions)

    struct ChatMessage: Codable {
        let role: String
        let content: String
    }

    struct ChatRequest: Codable {
        let model: String
        let messages: [ChatMessage]
        let temperature: Double
        let maxTokens: Int?

        enum CodingKeys: String, CodingKey {
            case model
            case messages
            case temperature
            case maxTokens = "max_tokens"
        }
    }

    struct ChatResponse: Decodable {
        struct Choice: Decodable {
            struct Message: Decodable {
                let content: MessageContent?
            }
            let message: Message
        }
        struct APIError: Decodable {
            let message: String?
        }
        let choices: [Choice]?
        let error: APIError?
    }

    // content kann String ODER Array von Content-Parts sein (je nach Modell/API-Version)
    enum MessageContent: Decodable {
        case text(String)
        case parts([Part])

        struct Part: Decodable {
            let text: String?
        }

        var string: String {
            switch self {
            case .text(let value): return value
            case .parts(let parts): return parts.compactMap(\.text).joined()
            }
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let value = try? container.decode(String.self) {
                self = .text(value)
            } else if let parts = try? container.decode([Part].self) {
                self = .parts(parts)
            } else {
                self = .text("")
            }
        }
    }

    static func generateRecipe(
        userWish: String,
        systemPrompt: String,
        settings: Settings
    ) async throws -> String {
        try await chatCompletion(systemPrompt: systemPrompt, userMessage: userWish, settings: settings)
    }

    /// Überarbeitet ein bestehendes Rezept anhand eines Änderungswunschs (z. B. "weniger scharf").
    static func generateRevision(
        existingMarkdown: String,
        instruction: String,
        systemPrompt: String,
        settings: Settings
    ) async throws -> String {
        let userMessage = "Überarbeite das folgende Rezept strikt gemäß diesem Änderungswunsch. Antworte ausschließlich mit dem vollständigen, überarbeiteten Rezept im Markdown-Format (gleiche Struktur wie das Original: Titel als #, Abschnitte, Zutatenliste, nummerierte Schritte).\n\nÄnderungswunsch:\n\(instruction)\n\nAktuelles Rezept:\n\(existingMarkdown)"
        return try await chatCompletion(systemPrompt: systemPrompt, userMessage: userMessage, settings: settings)
    }

    private static func chatCompletion(
        systemPrompt: String,
        userMessage: String,
        settings: Settings
    ) async throws -> String {
        guard !settings.apiKey.trimmingCharacters(in: .whitespaces).isEmpty else {
            throw AIError.missingAPIKey
        }
        var request = URLRequest(url: baseURL.appendingPathComponent("v1/chat/completions"))
        request.httpMethod = "POST"
        request.timeoutInterval = 180
        request.setValue("Bearer \(settings.apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body = ChatRequest(
            model: settings.effectiveModel,
            messages: [
                ChatMessage(role: "system", content: systemPrompt),
                ChatMessage(role: "user", content: userMessage),
            ],
            temperature: 0.4,
            maxTokens: 4096
        )
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw AIError.network("Ungültige Server-Antwort.")
        }
        guard (200..<300).contains(http.statusCode) else {
            let decoded = try? JSONDecoder().decode(ChatResponse.self, from: data)
            throw AIError.http(http.statusCode, decoded?.error?.message ?? Self.errorMessage(from: data))
        }
        let decoded: ChatResponse
        do {
            decoded = try JSONDecoder().decode(ChatResponse.self, from: data)
        } catch {
            throw AIError.invalidResponse(Self.errorMessage(from: data))
        }
        guard let content = decoded.choices?.first?.message.content?.string, !content.isEmpty else {
            let preview = Self.errorMessage(from: data)
            let apiMessage = decoded.error?.message.map { " API-Fehler: \($0)." } ?? ""
            throw AIError.invalidResponse("kein Inhalt in choices.\(apiMessage) Roh-Antwort: \(String(preview.prefix(400)))")
        }
        return stripCodeFence(content)
    }

    // MARK: - Hilfsfunktionen

    private static func errorMessage(from data: Data) -> String {
        String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "Unbekannter Fehler."
    }

    private static func stripCodeFence(_ text: String) -> String {
        var result = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if result.hasPrefix("```") {
            if let newline = result.firstIndex(of: "\n") {
                result.removeSubrange(result.startIndex..<newline)
            }
            result = result.trimmingCharacters(in: .whitespacesAndNewlines)
            if result.hasSuffix("```") {
                result.removeLast(3)
            }
        }
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
