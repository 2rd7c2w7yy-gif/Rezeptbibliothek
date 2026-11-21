import SwiftUI
import SwiftData

@main
struct RezeptBibliothekApp: App {
    let container: ModelContainer

    init() {
        let schema = Schema([Recipe.self])
        let configuration = Self.useCloudKit
            ? ModelConfiguration(schema: schema, groupContainer: .automatic, cloudKitDatabase: .automatic)
            : ModelConfiguration(schema: schema, isStoredInMemoryOnly: false)
        do {
            container = try ModelContainer(for: schema, configurations: configuration)
        } catch {
            fatalError("ModelContainer konnte nicht erstellt werden: \(error)")
        }
        SeedData.ensureSeeded(context: container.mainContext)
    }

    // Auf true setzen, sobald die CloudKit-Capability im Xcode-Projekt aktiviert ist (siehe README).
    static let useCloudKit = false

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .modelContainer(container)
    }
}
