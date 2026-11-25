import SwiftUI

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss

    @State private var apiKey = ""
    @AppStorage("aiModel") private var aiModel = MistralAIService.defaultModel
    @AppStorage("skillName") private var skillName = "rezepte-thermomix"
    @AppStorage("skillAlias") private var skillAlias = "main"
    @AppStorage("cookingDevice") private var deviceRaw = CookingDevice.thermomix.rawValue

    @State private var message: String?
    @State private var skillInfo: String?
    @State private var testingSkill = false

    private var settings: MistralAIService.Settings {
        MistralAIService.Settings(
            apiKey: KeychainService.loadAPIKey() ?? "",
            model: aiModel,
            skillName: skillName,
            skillAlias: skillAlias
        )
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Mistral API") {
                    SecureField("API-Key", text: $apiKey)
                        .textContentType(.password)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                    Button("Key im Schlüsselbund speichern") {
                        saveKey()
                    }
                    Link("API-Key in der Mistral Console erstellen", destination: URL(string: "https://console.mistral.ai")!)
                    Text("Der Key wird nur lokal im Schlüsselbund gespeichert und direkt an api.mistral.ai gesendet.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("Gerät") {
                    Picker("Gerät", selection: $deviceRaw) {
                        ForEach(CookingDevice.allCases) { Text($0.rawValue).tag($0.rawValue) }
                    }
                    Text("Bestimmt, für welches Gerät die KI das Rezept formuliert (z. B. TM6/TM7-Schritte oder freies Kochen).")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("Modell & Skill") {
                    TextField("Modell", text: $aiModel)
                        .autocorrectionDisabled()
                    TextField("Skill-Name", text: $skillName)
                        .autocorrectionDisabled()
                    TextField("Skill-Alias", text: $skillAlias)
                        .autocorrectionDisabled()
                    Button {
                        Task { await testSkill() }
                    } label: {
                        if testingSkill {
                            HStack { ProgressView(); Text("Skill wird abgerufen …") }
                        } else {
                            Label("Skill abrufen & testen", systemImage: "bolt.horizontal.circle")
                        }
                    }
                    .disabled(testingSkill)
                    if let skillInfo {
                        Text(skillInfo)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                if let message {
                    Section {
                        Text(message)
                            .font(.footnote)
                    }
                }
            }
            .navigationTitle("Einstellungen")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fertig") { dismiss() }
                }
            }
            .onAppear {
                apiKey = KeychainService.loadAPIKey() ?? ""
            }
        }
    }

    private func saveKey() {
        let key = apiKey.trimmingCharacters(in: .whitespaces)
        guard !key.isEmpty else {
            message = "Bitte zuerst einen API-Key eingeben."
            return
        }
        do {
            try KeychainService.saveAPIKey(key)
            message = "API-Key wurde im Schlüsselbund gespeichert."
        } catch {
            message = "Fehler beim Speichern: \(error.localizedDescription)"
        }
    }

    private func testSkill() async {
        testingSkill = true
        skillInfo = nil
        defer { testingSkill = false }
        do {
            let skill = try await MistralAIService.fetchSkill(settings: settings)
            let version = skill.version.map { "Version \($0)" } ?? "unbekannte Version"
            skillInfo = "Skill „\(skillName)“ erreichbar – \(version), \(skill.body.count) Zeichen."
        } catch {
            skillInfo = "Fehler: \(error.localizedDescription)"
        }
    }
}
