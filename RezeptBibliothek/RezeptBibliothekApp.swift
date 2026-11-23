import SwiftUI
import SwiftData

@main
struct RezeptBibliothekApp: App {
    let container: ModelContainer
    let generatorState = GeneratorState()

    init() {
        let schema = Schema([Recipe.self])
        let configuration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: false)
        do {
            container = try ModelContainer(for: schema, configurations: configuration)
        } catch {
            fatalError("ModelContainer konnte nicht erstellt werden: \(error)")
        }
        SeedData.ensureSeeded(context: container.mainContext)
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(generatorState)
        }
        .modelContainer(container)

        // Eigenes Fenster für den KI-Generator: zentriert auf dem Bildschirm, nie Vollbild,
        // inhaltsbasiert skalierbar.
        Window("Rezept mit KI", id: "ai-generator") {
            AIRecipeGeneratorView()
                .environment(generatorState)
        }
        .modelContainer(container)
        .defaultPosition(.center)
        .windowResizability(.contentSize)
        .defaultSize(width: 920, height: 800)
    }
}
