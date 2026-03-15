# CableQC System (Tauri + React)

This application is the Windows desktop console used to run cable quality operations on the shop floor. It combines a modern React/Vite frontend with a Rust-based Tauri backend so that operators, supervisors, and admins can share a single executable that talks to local databases, shared folders, and shop-floor hardware.

---

## High-level flow

1. **Config bootstrap**
   - At launch the Tauri backend loads `.env` and optional `admin.env` files, prepares database pools, and takes a snapshot of the environment (shared folders, API base URLs, hardware toggles, etc.).

2. **Role-based login**
   - The login screen lets the user pick between the standard “User” role and “Admin”.
   - `validate_login` reads the CSV indicated by `USER_LIST_DIR` (a file path or a directory) to confirm the badge ID and name. For non-admin users the CSV is copied into the shared cache so other stations can reuse it.

3. **System preflight**
   - After login the Startup page calls `perform_preflight`. The backend checks:
     - Application database connectivity (`APP_DB_*`).
     - Cable QC database connectivity (`CRIMP_DB_*` legacy variables).
     - Shared operator folder reachability (`SHARED_FOLDER` / `NETWORK_PHOTO_SHARE`).
     - Microscope photo directory availability (`MICROSCOPE_PHOTO_DIR`).
     - API reachability using the resolved base URL (`API_BASE_URL` and `ADMIN_API_BASE_URL`).
   - Results are stored in context so the UI can block progression when critical checks fail.

4. **Session preparation**
   - The Orders view captures operator badge, optional machine ID, and the fabrication orders scheduled for the run.
   - `start_session` synchronizes operator details with the user CSV, verifies unique active sessions in the `user_sessions` table, and upserts the current workstation/host entry.

5. **Production console**
   - Once an operator session and orders are declared the app unlocks the dashboard and other protected pages.
   - `get_dashboard_snapshot` currently returns mocked production metrics; replace with live queries when data sources are ready.
   - Additional features (wires library, microscope integration, comparator input capture) are toggled via the feature flags exposed in `.env`.

6. **Logout / cleanup**
   - `logout` clears the in-memory session and removes the operator association from the MySQL `user_sessions` table.

The entire stage progression is orchestrated by `AppFlowContext` (`src/context/AppFlowContext.tsx`), which watches for credentials, preflight success, session data, and declared orders before exposing the protected routes.

---

## Architecture overview

| Layer      | Location              | Responsibilities                                                                                  |
|------------|-----------------------|--------------------------------------------------------------------------------------------------|
| Frontend   | `src/`                | React + Vite UI, React Router flow control, Shadcn UI components, and React Query data fetching. |
| Backend    | `src-tauri/src/`      | Rust commands (login, preflight, session logging, dashboard snapshot) and environment management.|
| Packaging  | `src-tauri/tauri.conf.json` | Bundling, icon, updater, and build settings for the Tauri shell.                          |

Frontend to backend calls go through typed helpers under `src/lib/api.ts`, which wrap `@tauri-apps/api/tauri`’s `invoke` function so each page can call the Rust commands with JSON payloads.

---

## Prerequisites

Install these once per workstation:

- **Rust** via `rustup` with the stable toolchain and the Windows MSVC target that matches your architecture.
- **Node.js** 18 or later plus a package manager (`npm` is used in the examples).
- **Visual Studio Build Tools** (Desktop development with C++) so Tauri can link native dependencies.

Optional for production builds:

- Windows code signing certificate (configure in `tauri.conf.json`).
- MySQL client libraries if you intend to bundle them.

---

## Configuration files

All runtime settings are pulled from environment files:

| Group                    | Variables (examples)                                                                                         | Purpose |
|--------------------------|---------------------------------------------------------------------------------------------------------------|---------|
| Application DB           | `APP_DB_HOST`, `APP_DB_PORT`, `APP_DB_USER`, `APP_DB_PASS`, `APP_DB_NAME`, `APP_DB_SSL_DISABLED`, `APP_DB_CONN_TIMEOUT` | Auth/session tracking, app metadata. |
| Cable QC DB              | `CRIMP_DB_HOST`, `CRIMP_DB_PORT`, `CRIMP_DB_USER`, `CRIMP_DB_PASS`, `CRIMP_DB_NAME`, `CRIMP_DB_TABLE`                | Quality and tooling tolerances. |
| Operator assets          | `USER_LIST_DIR`, `SHARED_FOLDER`, `MASTER_HOST`, `USERLIST_URL`, `ADMIN_USERLIST_URL`, `ADMIN_ENV_URL`              | Resolve the user CSV and admin `.env` file from local directories or network shares. |
| APIs                     | `API_BASE_URL`, `ADMIN_API_BASE_URL`                                                                           | Product and reference data services (role-aware). |
| Microscope & comparator  | `MICROSCOPE_PHOTO_DIR`, `NETWORK_PHOTO_SHARE`, `COMP_USE_HID`, `COMP_COM_PORT`, `ENABLE_MICROSCOPE_TEST`, `ENABLE_CRIMP_TEST`, `TEST_CRIMP_HEIGHT`, `COMPARATOR_TEST` | Hardware integrations and feature flags. |
| Miscellaneous            | `LABEL_FORMAT`, `ENABLE_LABEL_PRINTING`, `URL_CALL_*`, `FILE_SERVER_PORT`    | Optional modules (label printing, sound alerts, test hooks). |

> **Windows path tip**  
> When pointing `USER_LIST_DIR`, `USERLIST_URL`, or similar variables at local files, prefer forward slashes (`G:/userlist.csv`) or wrap the path in quotes with escaped backslashes (`"G:\\userlist.csv"`). Raw backslashes without escaping cause dotenv parsing errors.

`USER_LIST_DIR` can point to a CSV file or a directory. When a directory is provided the backend searches for `userlist.csv`, `user_list.csv`, `users.csv`, or `operators.csv`; otherwise the first CSV in the folder is used.

`admin.env` is fetched into the shared folder so other stations can inherit admin-only overrides. Local `file://` URIs, UNC paths, or HTTP(S) endpoints are supported for both the CSV and `admin.env`.

---

## Installing and running

```bash
cd tauri-app
npm install          # install frontend packages
cargo fetch          # optional: warm up Rust dependencies
npm run tauri dev    # start Vite + Tauri in development mode
```

The dev task runs Vite’s hot-reload server and the Tauri shell simultaneously. The Rust backend reloads environment data at login and whenever `ensure_user_list` detects a fresh `admin.env`.

For a production bundle:

```bash
npm run tauri build
```

The output MSI/EXE lives under `src-tauri/target/release/`.

---

## End-to-end usage checklist

1. Populate `.env` with valid database credentials, shared folder paths, and hardware toggles.
2. Place the operator roster CSV in the location referenced by `USER_LIST_DIR`.
3. Verify the shared folder is writable from the workstation (backend copies the CSV there for non-admin roles).
4. Ensure MySQL servers are reachable from the workstation.
5. Launch the app:
   - Log in with a badge ID + full name from the CSV.
   - Run the startup validation and confirm databases/API/folders report “OK”.
   - On the Orders screen declare the operator session and fabrication orders.
   - Proceed to the dashboard and continue operations.

### Dummy data smoke test

To exercise the full UI progression without connecting to live infrastructure, build the frontend bundle and run the Vitest-based
smoke scenario. It injects deterministic dummy responses for all Tauri commands, drives the login → preflight → orders flow, and
asserts that the dashboard renders expected production metrics.

```bash
npm run build
npm run test:smoke
```

Use this combo after code changes to confirm the critical happy-path works even when hardware, databases, or the Tauri runtime are
unavailable.

If the comparator or microscope hardware is unavailable during development, set the associated feature flags (`ENABLE_CRIMP_TEST`, `ENABLE_MICROSCOPE_TEST`, etc.) to `false` so the UI can render without expecting device input. The runtime shell exposes these flags through the `get_feature_flags` command, allowing packaged builds to pick up overrides from a `.env` file placed next to the executable without rebuilding the frontend bundle.

---

## Backend commands (Rust)

| Command               | Description |
|-----------------------|-------------|
| `validate_login`      | Loads user CSV, matches badge ID + name, records the active credential in shared state. |
| `perform_preflight`   | Performs the run-time health checks described above. |
| `start_session`       | Associates the logged-in app user with an operator badge + optional machine ID, ensuring uniqueness in the MySQL `user_sessions` table. |
| `logout`              | Removes the operator session mapping and resets app state. |
| `get_dashboard_snapshot` | Returns the current production metrics (placeholder data until wired to real sources). |
| `greet`               | Sanity test command exposed to the frontend. |

All commands surface errors as user-friendly strings so the frontend can display them via toast notifications.

---

## Frontend modules (React)

- `AppFlowContext` – Stores credentials, preflight result, session info, and declared orders; controls route guards.
- `pages/Login.tsx` – Role selection and credential capture.
- `pages/Startup.tsx` – Visual preflight report with per-check status cards.
- `pages/Orders.tsx` – Operator/machine linkage and work-order declaration.
- `pages/Dashboard.tsx`, `pages/Wires.tsx`, `pages/Settings.tsx` – Protected console experience after a session is active.
- `components/` – Shared UI elements (sidebar, header, badges, tables, etc.) based on Shadcn UI.

React Query caches the dashboard snapshot and refreshes it on a polling interval so live data will populate instantly once the backend is wired to production sources.

---

## Troubleshooting

- **Login fails** – Confirm the CSV contains the badge ID + exact name, the file is readable, and `USER_LIST_DIR` points to the correct location. The backend will echo failures in Tauri’s devtools console.
- **Database checks fail** – Verify credentials and network access. The app attempts to create the `user_sessions` table automatically when `start_session` runs; ensure the MySQL user has permissions.
- **Shared folder errors** – The workstation must have write access to `SHARED_FOLDER`; UNC paths require the app to run under a user with network share permissions.
- **API unreachable** – Update `API_BASE_URL` / `ADMIN_API_BASE_URL` or disable dependent features until the service is live.
- **npm audit/outdated return 403** – Use the provided wrappers (`npm run audit`, `npm run outdated`). They clear proxy settings, force the public npm registry, and gracefully skip the check with a warning when the container is completely offline.
- **Hardware integrations** – Set comparator/microscope feature flags to `false` during development if devices are offline.

---

## Roadmap hints

- Replace the mocked dashboard snapshot with real metrics from the crimp database.
- Stream comparator readings via HID or serial depending on `COMP_USE_HID`.
- Attach microscope photo ingestion so operators can review the latest images directly in the app.
- Expose admin-only pages that leverage the `admin` role environment overrides.
