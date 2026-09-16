# Aenderungsuebersicht

## 2026-09-16 - Migration Audit Leitungsansicht

- Migration Audit verwendet jetzt kompakte, einklappbare Leitungskarten im Stil
  der Cross-Connect-Seite statt einer sehr breiten Tabelle.
- Jede Karte zeigt auf einen Blick Serial, Kunde/Standort, Vorgang und den
  vollständigen Weg **RFRA / A-PP → BB IN → BB OUT → Kunde / PP + Port**.
- Beim Aufklappen erscheinen nur die relevanten Audit-Informationen: das konkrete
  Problem der Leitung und eine Prüfliste für Patchpanel, Ports, Backbone,
  Kundenzuordnung, Serial und Konflikte.
- Fehlerhafte Leitungen bleiben nach Kategorie farblich getrennt; die bestehende
  Filterung, Historie, Pagination und Admin-Aktionen bleiben erhalten.
- Die responsive Darstellung wechselt auf kleineren Bildschirmen automatisch von
  der horizontalen Pfadzeile in eine gut lesbare Kartenanordnung.

## 2026-09-16 - Zuverlaessigkeit und Fehlerkorrekturen

### Anmeldung und Sitzungen

- Das Frontend verwendet automatisch seine eigene Serveradresse statt einer fest
  eingetragenen Firmenadresse. Separate Test-VMs, HTTPS und andere Backend-Ports
  funktionieren damit ohne Anpassung des JavaScripts.
- Logins mit und ohne "Angemeldet bleiben" vermischen keine alten Tokens,
  Benutzernamen oder Rollen mehr zwischen Local Storage und Session Storage.
- Abgelaufene API-Sitzungen fuehren zur Anmeldung zurueck. Die Login-Seite prueft
  vorhandene Tokens, statt allein wegen eines gespeicherten Tokens wieder ins
  Dashboard zu springen.
- Eine erforderliche Passwortaenderung wird auch nach einem Neuladen wieder
  angezeigt. Nach erfolgreicher Aenderung werden Token und Sitzungsdaten gemeinsam
  aktualisiert.
- Netzwerkprobleme und Serverfehler werden nicht mehr faelschlich als falsches
  Passwort angezeigt. Doppelte Login-Anfragen und veraltete Sitzungsantworten
  werden abgefangen.
- Logout entfernt nur Anmeldedaten; Theme und andere gespeicherte Einstellungen
  bleiben erhalten. Die Login-Zeit wird auch bei einer reinen Tab-Sitzung angezeigt.
- Benutzernamen werden in der Navigation als Text und nicht als HTML eingesetzt.
- Der gemeinsame Fetch-Wrapper erhaelt Methoden und Header von `Request`-Objekten.
  App-Tokens werden nur an die eigene API gesendet; fremde Anfragen bleiben
  unveraendert.

### Backend und Datenlisten

- Beim Sperren/Freigeben von Patchpanel-Kassetten werden HTTP-Fehler jetzt
  angezeigt statt als Erfolg bestaetigt. Die Auswahl bleibt erhalten und die
  Aktion kann nach einem Fehler erneut ausgefuehrt werden.
- Cross-Connect-Listen werden nicht mehr bei den ersten 5.000 Datenbankzeilen
  abgeschnitten. Gesamtzahl und Seiten beziehen sich auf das vollstaendige
  gefilterte Ergebnis.
- Suche, Datumsfilter und angezeigte Pending-Status werden vor der SQL-Paginierung
  beruecksichtigt. Bei gleichen Erstellungszeiten sorgt die ID fuer eine stabile
  Reihenfolge zwischen den Seiten.
- Im Migration Audit wurde eine unnoetige zusaetzliche COUNT-Abfrage entfernt.
  Bestehende Deduplizierung, Konfliktklassen und Seitenzahlen bleiben unveraendert.
- Der alternative Excel-Exportpfad `/api/v1/cross_connects/export` verlangt jetzt
  dieselbe Anmeldung wie die regulaere API. Angemeldete Viewer koennen weiterhin
  exportieren.
- Die automatische Umstellung alter Klartext-Passwoerter auf bcrypt beim Login
  wird dauerhaft gespeichert und nicht mehr durch die anschliessende
  Login-Protokollierung zurueckgerollt.
- Optionale Berechtigungstabellen werden ueber Savepoints gelesen. Eine fehlende
  Legacy-Tabelle verwirft keine anderen Aenderungen der laufenden Transaktion;
  unerwartete Datenbankfehler werden nicht als leere Berechtigungen verschluckt.
- Fehler bei der Login-/Passwortaenderungs-Protokollierung werden geloggt.
  Unnoetiges SQL-Echo im normalen Betrieb ist deaktiviert.

### Deployment und Dokumentation

- `DB_PORT` aus der Umgebung wird jetzt tatsaechlich vom Compose-Stack verwendet.
  Der Default ist `127.0.0.1:5433` **auf dem Docker-Host** statt einer Bindung an
  alle Netzwerkschnittstellen. Bestehende direkte DB-Zugriffe von anderen Rechnern
  benoetigen daher einen SSH-Tunnel oder eine bewusst konfigurierte Host-Bindung.
- Die README beschreibt den tatsaechlichen pgAdmin-Start, den Update-Branch,
  lokale Frontend-Adressen und sichere Test-Deployments.
- Wichtiger Hinweis zur Isolation: Der Stack nutzt feste Container-, Netzwerk-
  und Volume-Namen. Fuer einen parallelen Teststand mit dieser Compose-Datei
  eine separate VM / einen separaten Docker-Host verwenden.
- Automatisierte Frontend- und Backend-Regressionstests sowie GitHub Actions
  wurden ergaenzt. Die Testdaten sind synthetisch; eine produktive Datenbank wird
  fuer diese Tests nicht verwendet.

### Update ausprobieren

1. Ein aktuelles Datenbank-Backup erstellen.
2. Im Git-basierten Portainer-Stack den Branch
   `sherzai-equinix-app-verbesserungen` auswaehlen und mit neuem Backend-Build
   redeployen. Fuer einen parallelen Teststand einen getrennten Docker-Host nutzen.
3. Die Frontend-Seite mit Strg+F5 neu laden, damit die aktualisierten Scripts
   verwendet werden.
4. Anmeldung mit/ohne "Angemeldet bleiben", Logout, ggf. den erzwungenen
   Passwortwechsel, Cross-Connect-Suche/Statusfilter/weitere Seiten und
   Excel-Export sowie das Sperren/Freigeben von Test-Kassetten ausprobieren.

Dieses Update benoetigt keine neue SQL-Migration. Bestehende Volume-Namen bleiben
unveraendert; fuer das Update keine Datenbank-Volumes loeschen.
