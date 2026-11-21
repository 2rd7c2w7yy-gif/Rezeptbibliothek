import SwiftUI
import SwiftData

@main
struct RezeptBibliothekApp: App {
    let container: ModelContainer

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
        }
        .modelContainer(container)
    }
}
