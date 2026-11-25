import SwiftUI
import SwiftData

@main
struct RezeptBibliothekApp: App {
    let container: ModelContainer
    let generatorState = GeneratorState()

    init() {
        let schema = Schema([Recipe.self])
        let dir = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let storeURL = dir.appendingPathComponent("RezeptBibliothek.sqlite")

        let configuration = ModelConfiguration(schema: schema, url: storeURL)

        do {
            container = try ModelContainer(for: schema, configurations: configuration)
        } catch {
            // Schema-Änderung (z. B. neues Modell-Feld): alten Store samt WAL/SHM entfernen
            // und leer neu anlegen (Seed-Daten werden danach wieder eingespielt).
            print("ModelContainer-Fehler, starte mit leerem Store neu: \(error)")
            let base = storeURL.deletingPathExtension().path + ".sqlite"
            for suffix in ["", "-wal", "-shm"] {
                try? FileManager.default.removeItem(atPath: base + suffix)
            }
            do {
                container = try ModelContainer(for: schema, configurations: configuration)
            } catch {
                fatalError("ModelContainer konnte nicht erstellt werden: \(error)")
            }
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
