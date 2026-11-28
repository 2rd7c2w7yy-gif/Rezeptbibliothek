# RezeptBibliothek

Eine native SwiftUI-App für **Mac (MacBook), iPhone und iPad** (ein gemeinsamer Code, Multiplatform-Target), mit der du Rezepte **mit deiner Mistral-KI erstellen** und in einer **Bibliothek verwalten** kannst. Jedes Rezept lässt sich als **druckoptimiertes PDF (DIN A4, max. 2 Seiten)** exportieren.

Die KI nutzt dabei **deinen eigenen Skill `rezepte-thermomix`** aus dem Mistral Studio: Die App lädt den Skill zur Laufzeit über die Mistral API (`GET /v2/skills/skill:rezepte-thermomix?alias=main`) und verwendet ihn als System-Prompt für die Chat Completion (`POST /v1/chat/completions`). Ist das Studio nicht erreichbar, fällt die App auf eine im App-Bundle eingebettete Kopie des Skills zurück (`RezeptBibliothek/Resources/FallbackSkill.md`).

## Web-App (GitHub Pages, nur GitHub – kein Supabase) – oeffentlich lesbar, nur Besitzer schreibt

Im Ordner `docs/` liegt die statische Web-App (plain HTML/CSS/JS). **Lesen ist oeffentlich – kein Login, kein GitHub-Konto fuer Besucher.** Die Bibliothek liegt in einem **oeffentlichen GitHub-Repo** `rezeptbibliothek-bibliothek` (wird beim ersten Besitzer-Login automatisch angelegt). **Nur der Besitzer** meldet sich mit seinem **GitHub-Token** an (Button „Besitzer-Login“) und kann Rezepte per KI erstellen/ueberarbeiten/loeschen sowie Gruppen anlegen. Alle anderen sehen die Bibliothek schreibgeschuetzt (suchen, filtern, Favoriten lokal, PDF-Druck).

- **Besitzer-Login**: GitHub classic Token, Scope `repo` (github.com/settings/tokens → Tokens (classic) → „Generate new token (classic)“; alternativ Token ueber die gh-CLI im Terminal erzeugen und mit `gh auth token`-Pendant auslesen). Token bleibt lokal im Browser (localStorage), wird nur an api.github.com gesendet.
- **Schreibschutz**: Schreiben geht nur ueber die GitHub-Contents-API mit dem Token des Repo-Owners – serverseitig erzwungen (oeffentliches Repo, nur Owner hat Schreibrechte). Die App blendet Besitzer-Funktionen ohne Login aus.
- **KI (Mistral)**: nur Besitzer; Key lokal im Browser (localStorage), nur an api.mistral.ai. Skill `rezepte-thermomix` live aus dem Studio, Fallback `docs/fallback-skill.md`.
- **Rezept-URL teilen (JSON-LD)**: Rezeptansicht → „🔗 Rezept-URL teilen“ (nur Besitzer) → öffentliche `raw.githubusercontent.com`-URL mit schema.org JSON-LD. Funktioniert mit offenen Import-Tools (z. B. MCS Recipe Importer / mcsrecipe.com für Lidl Monsieur Cuisine, AnyList, Paprika). Cookidoo akzeptiert nur Whitelist-URLs → dafür „📋 Text kopieren“. Der Monsieur Cuisine selbst importiert keine URLs direkt.
