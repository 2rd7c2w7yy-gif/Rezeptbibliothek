import SwiftUI
import SwiftData
import Observation

/// Gemeinsamer Zustand, über den das KI-Fenster geöffnet wird –
/// leer für ein neues Rezept, gefüllt für eine Überarbeitung.
@Observable
final class GeneratorState {
    var existingRecipe: Recipe?
    var existingMarkdown: String?
    var existingTitle: String?

    func reset() {
        existingRecipe = nil
        existingMarkdown = nil
        existingTitle = nil
    }
}

struct AIRecipeGeneratorView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismissWindow) private var dismissWindow
    @Environment(GeneratorState.self) private var genState

    @AppStorage("aiModel") private var aiModel = MistralAIService.defaultModel
    @AppStorage("skillName") private var skillName = "rezepte-thermomix"
    @AppStorage("skillAlias") private var skillAlias = "main"

    @State private var wish = ""
    @State private var revisionWish = ""
    @State private var category: RecipeCategory = .general
    @State private var phase: Phase = .idle
    @State private var statusMessage = ""
    @State private var resultMarkdown = ""
    @State private var errorMessage: String?
    @State private var saved = false

    enum Phase {
        case idle
        case loadingSkill
        case generating
        case done
    }

    private var isRefining: Bool { genState.existingRecipe != nil }

    private var settings: MistralAIService.Settings {
        MistralAIService.Settings(
            apiKey: KeychainService.loadAPIKey() ?? "",
            model: aiModel,
            skillName: skillName,
            skillAlias: skillAlias
        )
    }

    private var extractedTitle: String {
        Self.extractTitle(from: resultMarkdown)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section(isRefining ? "Änderungswunsch an die KI" : "Dein Wunsch an die KI") {
                    TextEditor(text: $wish)
                        .frame(minHeight: 110)
                    Text(isRefining
                         ? "z. B. „weniger scharf, mehr Knoblauch, Backzeit 10 Min. kürzer“"
                         : "z. B. „Eine vegane Linsensuppe für 4 Personen, scharf, in 30 Minuten“")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Picker("Kategorie", selection: $category) {
                        ForEach(RecipeCategory.allCases.filter { $0 != .all }) { Text($0.rawValue).tag($0) }
                    }
                }

                Section {
                    Button {
                        Task { await generate() }
                    } label: {
                        if phase == .loadingSkill || phase == .generating {
                            HStack {
                                ProgressView()
                                Text(statusMessage)
                            }
                        } else {
                            Label(isRefining ? "Überarbeiten (KI)" : "Rezept generieren", systemImage: "sparkles")
                        }
                    }
                    .disabled(wish.trimmingCharacters(in: .whitespaces).isEmpty
                               || phase == .loadingSkill
                               || phase == .generating)
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                            .font(.footnote)
                            .textSelection(.enabled)
                    }
                }

                if phase == .done {
                    Section("Vorschau – \(extractedTitle)") {
                        MarkdownContentView(markdown: resultMarkdown)
                    }

                    // Weitere KI-Befehle zur Überarbeitung des angezeigten Rezepts
                    Section("Weiter überarbeiten (KI)") {
                        TextEditor(text: $revisionWish)
                            .frame(minHeight: 60)
                        Text("z. B. „noch saftiger“, „Sauce separat“, „für 6 Personen“")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Button {
                            Task { await revise() }
                        } label: {
                            if phase == .loadingSkill || phase == .generating {
                                HStack {
                                    ProgressView()
                                    Text(statusMessage)
                                }
                            } else {
                                Label("Änderung mit KI anwenden", systemImage: "arrow.triangle.2.circlepath")
                            }
                        }
                        .disabled(revisionWish.trimmingCharacters(in: .whitespaces).isEmpty
                                   || phase == .loadingSkill
                                   || phase == .generating)
                    }

                    Section {
                        Button {
                            save()
                        } label: {
                            Label(saved
                                  ? "Gespeichert"
                                  : (isRefining ? "Rezept aktualisieren" : "In Bibliothek speichern"),
                                  systemImage: saved ? "checkmark.circle.fill" : "tray.and.arrow.down")
                        }
                        .disabled(saved || resultMarkdown.isEmpty)

                        Button {
                            Task { await generate() }
                        } label: {
                            Label("Erneut generieren", systemImage: "arrow.clockwise")
                        }
                        .disabled(phase == .loadingSkill || phase == .generating)
                    }
                }
            }
            .navigationTitle(isRefining ? "Rezept überarbeiten (KI)" : "Neues Rezept mit KI")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Schließen") {
                        genState.reset()
                        dismissWindow(id: "ai-generator")
                    }
                }
            }
            .onAppear {
                if let existing = genState.existingMarkdown, !existing.isEmpty {
                    resultMarkdown = existing
                    phase = .done
                    wish = ""
                } else {
                    resultMarkdown = ""
                    phase = .idle
                }
            }
        }
    }

    private func generate() async {
        errorMessage = nil
        saved = false
        phase = .loadingSkill
        statusMessage = "Skill „\(skillName)“ wird aus dem Studio geladen …"
        do {
            let (prompt, source) = try await SkillProvider.systemPrompt(for: settings)
            phase = .generating
            statusMessage = isRefining
                ? "Rezept wird überarbeitet … (\(source))"
                : "Rezept wird erstellt … (\(source))"
            let result: String
            if isRefining {
                let base = resultMarkdown.isEmpty ? (genState.existingMarkdown ?? "") : resultMarkdown
                result = try await MistralAIService.generateRevision(
                    existingMarkdown: base,
                    instruction: wish,
                    systemPrompt: prompt,
                    settings: settings
                )
            } else {
                result = try await MistralAIService.generateRecipe(
                    userWish: wish,
                    systemPrompt: prompt,
                    settings: settings
                )
            }
            resultMarkdown = result
            phase = .done
        } catch {
            phase = .idle
            errorMessage = error.localizedDescription
        }
    }

    private func revise() async {
        errorMessage = nil
        guard !resultMarkdown.isEmpty else { return }
        phase = .loadingSkill
        statusMessage = "Skill „\(skillName)“ wird geladen …"
        do {
            let (prompt, source) = try await SkillProvider.systemPrompt(for: settings)
            phase = .generating
            statusMessage = "KI überarbeitet das Rezept … (\(source))"
            let revised = try await MistralAIService.generateRevision(
                existingMarkdown: resultMarkdown,
                instruction: revisionWish,
                systemPrompt: prompt,
                settings: settings
            )
            resultMarkdown = revised
            revisionWish = ""
            phase = .done
        } catch {
            phase = .idle
            errorMessage = error.localizedDescription
        }
    }

    private func save() {
        guard !resultMarkdown.isEmpty else { return }
        if let existing = genState.existingRecipe {
            existing.markdown = resultMarkdown
            if !extractedTitle.isEmpty {
                existing.title = extractedTitle
            }
            existing.category = category.rawValue
            try? modelContext.save()
        } else {
            let recipe = Recipe(
                title: extractedTitle,
                markdown: resultMarkdown,
                category: category.rawValue
            )
            modelContext.insert(recipe)
            try? modelContext.save()
        }
        saved = true
        genState.reset()
        dismissWindow(id: "ai-generator")
    }

    static func extractTitle(from markdown: String) -> String {
        for raw in markdown.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("# ") {
                let title = String(line.dropFirst(2)).trimmingCharacters(in: .whitespaces)
                if !title.isEmpty { return title }
            }
        }
        for raw in markdown.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
                .replacingOccurrences(of: "#", with: "")
                .trimmingCharacters(in: .whitespaces)
            if !line.isEmpty { return line }
        }
        return "Neues Rezept"
    }
}
