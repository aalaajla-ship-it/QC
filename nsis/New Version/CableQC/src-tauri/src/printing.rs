use crate::{
    current_session_snapshot, ensure_logging_tables, env_bool, env_string, insert_session_log,
    logging, AppError, AppState, SHARED_IMAGES_DIR, SHARED_IMAGES_LEGACY_DIR, SHARED_LOG_DIR,
    SHARED_PDF_DIR,
};
use ab_glyph::{Font, FontRef, PxScale, ScaleFont};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use chrono::Local;
use core::ffi::c_void;
use image::{ImageBuffer, Luma};
use imageproc::drawing::draw_text_mut;
use mysql::{params, prelude::Queryable, Error as MysqlError, PooledConn, Row};
use printpdf::{Mm, Op, PdfDocument, PdfPage, PdfSaveOptions, Pt, RawImage, XObjectTransform};
use qrcode::QrCode;
use rand::{distributions::Uniform, Rng};
use serde::{Deserialize, Serialize};
use serde_json::{from_str, to_string_pretty};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

const CREATE_USER_SETTINGS_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS user_settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  app_user_id VARCHAR(64) NOT NULL,
  operator_id VARCHAR(64) NOT NULL,
  label_format VARCHAR(16) NULL,
  label_printer_name VARCHAR(255) NULL,
  tspl_width_mm DECIMAL(10,3) NULL,
  tspl_height_mm DECIMAL(10,3) NULL,
  tspl_gap_mm DECIMAL(10,3) NULL,
  tspl_speed INT NULL,
  tspl_density INT NULL,
  tspl_direction INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_user_operator (app_user_id, operator_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"#;
const CREATE_LABEL_COUNTERS_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS label_counters(
  id INT PRIMARY KEY DEFAULT 1,
  last_value INT NOT NULL DEFAULT 0
)ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"#;

static FONT_BYTES: once_cell::sync::Lazy<Vec<u8>> = once_cell::sync::Lazy::new(|| {
    let encoded = include_str!("../assets/fonts/DejaVuSans.base64");
    BASE64_STANDARD
        .decode(encoded.trim())
        .expect("embedded font should decode")
});
const LABEL_WIDTH_MM: f32 = 100.0;
const LABEL_HEIGHT_MM: f32 = 18.0;
const LABEL_DPI: f32 = 203.0;
const DEFAULT_TSPL_SPEED: i32 = 4;
const DEFAULT_TSPL_DENSITY: i32 = 8;
const DEFAULT_TSPL_DIRECTION: i32 = 1;
const PRINTER_SETTINGS_CACHE_DIR: &str = "printer_settings";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TsplSettings {
    pub width_mm: f32,
    pub height_mm: f32,
    pub gap_mm: f32,
    pub speed: i32,
    pub density: i32,
    pub direction: i32,
}

fn default_tspl_settings() -> TsplSettings {
    TsplSettings {
        width_mm: LABEL_WIDTH_MM,
        height_mm: LABEL_HEIGHT_MM,
        gap_mm: 2.0,
        speed: DEFAULT_TSPL_SPEED,
        density: DEFAULT_TSPL_DENSITY,
        direction: DEFAULT_TSPL_DIRECTION,
    }
}

fn clamp_range(value: i32, min: i32, max: i32) -> i32 {
    if value < min {
        min
    } else if value > max {
        max
    } else {
        value
    }
}

fn normalize_tspl_settings(input: &TsplSettings) -> Result<TsplSettings, AppError> {
    if !input.width_mm.is_finite() || input.width_mm <= 0.0 {
        return Err(AppError::Config(
            "Label width must be a positive number of millimetres.".into(),
        ));
    }
    if !input.height_mm.is_finite() || input.height_mm <= 0.0 {
        return Err(AppError::Config(
            "Label height must be a positive number of millimetres.".into(),
        ));
    }
    if !input.gap_mm.is_finite() || input.gap_mm < 0.0 {
        return Err(AppError::Config(
            "Label gap must be zero or a positive number of millimetres.".into(),
        ));
    }
    let direction = match input.direction {
        0 | 1 => input.direction,
        other => {
            return Err(AppError::Config(format!(
                "TSPL direction must be 0 (normal) or 1 (reverse). Got {other}."
            )));
        }
    };
    let speed = clamp_range(input.speed, 1, 12);
    let density = clamp_range(input.density, 0, 15);

    Ok(TsplSettings {
        width_mm: (input.width_mm * 1000.0).round() / 1000.0,
        height_mm: (input.height_mm * 1000.0).round() / 1000.0,
        gap_mm: (input.gap_mm * 1000.0).round() / 1000.0,
        speed,
        density,
        direction,
    })
}

fn resolve_tspl_settings(user_settings: &UserPrinterSettings) -> TsplSettings {
    if let Some(existing) = &user_settings.tspl {
        normalize_tspl_settings(existing).unwrap_or_else(|err| {
            logging::log_warn(&format!(
                "Invalid TSPL settings detected; reverting to defaults: {err}"
            ));
            default_tspl_settings()
        })
    } else {
        default_tspl_settings()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelPrinterSettingsResponse {
    pub enabled: bool,
    pub label_format: Option<String>,
    pub label_printer_name: Option<String>,
    pub default_format: Option<String>,
    pub resolved_format: Option<String>,
    pub tspl_settings: TsplSettings,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveLabelPrinterSettingsRequest {
    pub label_format: String,
    pub label_printer_name: Option<String>,
    pub tspl_settings: Option<TsplSettings>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleLabelRequest {
    pub product_ref: String,
    pub of_id: String,
    pub ref_wire: String,
    pub ref_coil: String,
    pub marquage: Option<String>,
    pub quantity: i32,
    pub length_mm: Option<i32>,
    pub machine_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleLabelResult {
    pub format: String,
    pub label_id: String,
    pub path: Option<String>,
    pub printer_name: Option<String>,
    pub skipped: bool,
    pub message: Option<String>,
}

struct UserPrinterSettings {
    format: Option<String>,
    printer_name: Option<String>,
    tspl: Option<TsplSettings>,
}

fn empty_user_printer_settings() -> UserPrinterSettings {
    UserPrinterSettings {
        format: None,
        printer_name: None,
        tspl: None,
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedPrinterSettings {
    format: Option<String>,
    printer_name: Option<String>,
    tspl: Option<TsplSettings>,
}

fn normalize_cached_string(value: Option<String>) -> Option<String> {
    value
        .map(|raw| raw.trim().to_string())
        .filter(|normalized| !normalized.is_empty())
}

fn cached_settings_root() -> PathBuf {
    if let Some(shared) = env_string("SHARED_FOLDER") {
        let candidate = Path::new(&shared).join(PRINTER_SETTINGS_CACHE_DIR);
        if ensure_directory(candidate.as_path()).is_ok() {
            return candidate;
        }
        logging::log_warn(&format!(
            "Unable to prepare printer settings cache at {}; falling back to local cache.",
            candidate.display()
        ));
    }

    let fallback_base = Path::new("operator-cache");
    if let Err(err) = ensure_directory(fallback_base) {
        logging::log_warn(&format!(
            "Unable to create operator cache directory {}: {err}",
            fallback_base.display()
        ));
    }

    let fallback = fallback_base.join(PRINTER_SETTINGS_CACHE_DIR);
    if let Err(err) = ensure_directory(fallback.as_path()) {
        logging::log_warn(&format!(
            "Unable to prepare fallback printer settings cache at {}: {err}",
            fallback.display()
        ));
    }
    fallback
}

fn cached_settings_path(user_id: &str, operator_id: &str) -> PathBuf {
    let root = cached_settings_root();
    let user_component = safe_label_component(user_id, "user");
    let operator_component = safe_label_component(operator_id, "operator");
    root.join(format!("{user_component}__{operator_component}.json"))
}

fn load_cached_printer_settings(
    user_id: &str,
    operator_id: &str,
) -> Result<Option<UserPrinterSettings>, AppError> {
    let path = cached_settings_path(user_id, operator_id);
    if !path.exists() {
        return Ok(None);
    }
    let contents = fs::read_to_string(&path)?;
    match from_str::<CachedPrinterSettings>(&contents) {
        Ok(cached) => Ok(Some(UserPrinterSettings {
            format: normalize_cached_string(cached.format),
            printer_name: normalize_cached_string(cached.printer_name),
            tspl: cached.tspl,
        })),
        Err(err) => {
            logging::log_warn(&format!(
                "Ignoring cached printer settings at {} due to parse error: {err}",
                path.display()
            ));
            Ok(None)
        }
    }
}

fn save_cached_printer_settings(
    user_id: &str,
    operator_id: &str,
    format: &str,
    printer_name: Option<&str>,
    tspl: &TsplSettings,
) -> Result<(), AppError> {
    let path = cached_settings_path(user_id, operator_id);
    if let Some(parent) = path.parent() {
        ensure_directory(parent)?;
    }
    let cached = CachedPrinterSettings {
        format: Some(format.to_string()),
        printer_name: printer_name
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        tspl: Some(tspl.clone()),
    };
    let json = to_string_pretty(&cached).map_err(|err| {
        AppError::Config(format!(
            "Unable to serialize cached printer settings: {err}"
        ))
    })?;
    fs::write(&path, json)?;
    Ok(())
}

fn fallback_printer_settings(
    reason: String,
    user_id: &str,
    operator_id: &str,
) -> (UserPrinterSettings, Option<String>) {
    match load_cached_printer_settings(user_id, operator_id) {
        Ok(Some(settings)) => {
            logging::log_warn(&format!(
                "Printer settings loaded from cache for {user_id}/{operator_id}: {reason}"
            ));
            (
                settings,
                Some(format!(
                    "Printer settings loaded from local cache because {reason}"
                )),
            )
        }
        Ok(None) => {
            logging::log_warn(&format!(
                "Printer settings defaulted for {user_id}/{operator_id}: {reason}"
            ));
            (
                empty_user_printer_settings(),
                Some(format!("Printer settings defaulted because {reason}")),
            )
        }
        Err(err) => {
            logging::log_warn(&format!(
                "Printer settings cache unavailable for {user_id}/{operator_id}: {reason}. Cache error: {err}"
            ));
            (
                empty_user_printer_settings(),
                Some(format!(
                    "Printer settings defaulted because {reason}. Failed to read cached settings: {err}"
                )),
            )
        }
    }
}

fn ensure_user_settings_column(conn: &mut PooledConn, definition: &str) -> Result<(), AppError> {
    let column_name = definition
        .split_whitespace()
        .next()
        .ok_or_else(|| AppError::Config(format!("Invalid column definition: {definition}")))?;
    let existing: Option<Row> = conn.exec_first(
        "SHOW COLUMNS FROM user_settings LIKE :column",
        params! { "column" => column_name },
    )?;
    if existing.is_some() {
        return Ok(());
    }
    let alter_sql = format!("ALTER TABLE user_settings ADD COLUMN {definition}");
    match conn.query_drop(alter_sql) {
        Ok(()) => Ok(()),
        Err(MysqlError::MySqlError(ref err)) if err.code == 1060 => Ok(()),
        Err(err) => Err(AppError::from(err)),
    }
}

fn ensure_user_settings(conn: &mut PooledConn) -> Result<(), AppError> {
    conn.query_drop(CREATE_USER_SETTINGS_SQL)?;
    ensure_user_settings_column(conn, "tspl_width_mm DECIMAL(10,3) NULL")?;
    ensure_user_settings_column(conn, "tspl_height_mm DECIMAL(10,3) NULL")?;
    ensure_user_settings_column(conn, "tspl_gap_mm DECIMAL(10,3) NULL")?;
    ensure_user_settings_column(conn, "tspl_speed INT NULL")?;
    ensure_user_settings_column(conn, "tspl_density INT NULL")?;
    ensure_user_settings_column(conn, "tspl_direction INT NULL")?;
    Ok(())
}

fn load_user_printer_settings(
    conn: &mut PooledConn,
    user_id: &str,
    operator_id: &str,
) -> Result<UserPrinterSettings, AppError> {
    ensure_user_settings(conn)?;
    let row: Option<Row> = conn.exec_first(
        "SELECT label_format, label_printer_name, tspl_width_mm, tspl_height_mm, tspl_gap_mm, tspl_speed, tspl_density, tspl_direction FROM user_settings WHERE app_user_id = ? AND operator_id = ?",
        (user_id, operator_id),
    )?;
    if let Some(mut row) = row {
        let format = row
            .take::<Option<String>, _>("label_format")
            .unwrap_or(None)
            .map(|v| v.trim().to_ascii_lowercase())
            .filter(|v| !v.is_empty());
        let printer_name = row
            .take::<Option<String>, _>("label_printer_name")
            .unwrap_or(None)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let width_mm = row
            .take::<Option<f64>, _>("tspl_width_mm")
            .unwrap_or(None)
            .map(|value| value as f32);
        let height_mm = row
            .take::<Option<f64>, _>("tspl_height_mm")
            .unwrap_or(None)
            .map(|value| value as f32);
        let gap_mm = row
            .take::<Option<f64>, _>("tspl_gap_mm")
            .unwrap_or(None)
            .map(|value| value as f32);
        let speed = row.take::<Option<i32>, _>("tspl_speed").unwrap_or(None);
        let density = row.take::<Option<i32>, _>("tspl_density").unwrap_or(None);
        let direction = row.take::<Option<i32>, _>("tspl_direction").unwrap_or(None);
        let tspl = match (width_mm, height_mm, gap_mm, speed, density, direction) {
            (Some(width), Some(height), Some(gap), Some(speed), Some(density), Some(direction)) => {
                Some(TsplSettings {
                    width_mm: width,
                    height_mm: height,
                    gap_mm: gap,
                    speed,
                    density,
                    direction,
                })
            }
            _ => None,
        };
        Ok(UserPrinterSettings {
            format,
            printer_name,
            tspl,
        })
    } else {
        Ok(UserPrinterSettings {
            format: None,
            printer_name: None,
            tspl: None,
        })
    }
}

fn upsert_user_printer_settings(
    conn: &mut PooledConn,
    user_id: &str,
    operator_id: &str,
    format: &str,
    printer_name: Option<&str>,
    tspl: &TsplSettings,
) -> Result<(), AppError> {
    ensure_user_settings(conn)?;
    conn.exec_drop(
        "INSERT INTO user_settings (app_user_id, operator_id, label_format, label_printer_name, tspl_width_mm, tspl_height_mm, tspl_gap_mm, tspl_speed, tspl_density, tspl_direction) \
         VALUES (:user_id, :operator_id, :format, :printer_name, :tspl_width, :tspl_height, :tspl_gap, :tspl_speed, :tspl_density, :tspl_direction) \
         ON DUPLICATE KEY UPDATE label_format = VALUES(label_format), label_printer_name = VALUES(label_printer_name), tspl_width_mm = VALUES(tspl_width_mm), tspl_height_mm = VALUES(tspl_height_mm), tspl_gap_mm = VALUES(tspl_gap_mm), tspl_speed = VALUES(tspl_speed), tspl_density = VALUES(tspl_density), tspl_direction = VALUES(tspl_direction)",
        params! {
            "user_id" => user_id,
            "operator_id" => operator_id,
            "format" => format,
            "printer_name" => printer_name,
            "tspl_width" => tspl.width_mm,
            "tspl_height" => tspl.height_mm,
            "tspl_gap" => tspl.gap_mm,
            "tspl_speed" => tspl.speed,
            "tspl_density" => tspl.density,
            "tspl_direction" => tspl.direction,
        },
    )?;
    Ok(())
}

fn fetch_printer_settings_or_default(
    state: &AppState,
    user_id: &str,
    operator_id: &str,
) -> (UserPrinterSettings, Option<String>) {
    match state.app_pool() {
        Ok(pool) => match pool.get_conn() {
            Ok(mut conn) => match load_user_printer_settings(&mut conn, user_id, operator_id) {
                Ok(settings) => (settings, None),
                Err(err) => fallback_printer_settings(
                    format!("a database error occurred: {err}"),
                    user_id,
                    operator_id,
                ),
            },
            Err(err) => fallback_printer_settings(
                format!("the database connection failed: {}", AppError::from(err)),
                user_id,
                operator_id,
            ),
        },
        Err(err) => fallback_printer_settings(
            format!("the database is unavailable: {err}"),
            user_id,
            operator_id,
        ),
    }
}

fn resolve_default_format() -> Option<String> {
    env_string("LABEL_FORMAT")
        .or_else(|| env_string("VITE_LABEL_FORMAT"))
        .map(|value| value.to_ascii_lowercase())
}

fn label_printing_enabled() -> bool {
    let fallbacks = [
        env_bool("ENABLE_LABEL_PRINTING", true),
        env_bool("VITE_ENABLE_LABEL_PRINTING", true),
    ];
    fallbacks.iter().any(|enabled| *enabled)
}

fn font() -> FontRef<'static> {
    FontRef::try_from_slice(&FONT_BYTES).expect("embedded font should load")
}

fn ensure_directory(path: &Path) -> Result<(), AppError> {
    if path.exists() {
        return Ok(());
    }
    fs::create_dir_all(path)?;
    Ok(())
}

fn base_output_dir() -> PathBuf {
    if let Some(shared) = env_string("SHARED_FOLDER") {
        let pdf_dir = Path::new(&shared).join(SHARED_PDF_DIR);
        if ensure_directory(&pdf_dir).is_ok() {
            return pdf_dir;
        }
        let images_dir = Path::new(&shared).join(SHARED_IMAGES_DIR);
        if ensure_directory(&images_dir).is_ok() {
            return images_dir;
        }
        let legacy_dir = Path::new(&shared).join(SHARED_IMAGES_LEGACY_DIR);
        if ensure_directory(&legacy_dir).is_ok() {
            return legacy_dir;
        }
    }
    let fallback = Path::new(SHARED_PDF_DIR);
    if ensure_directory(fallback).is_ok() {
        return fallback.to_path_buf();
    }
    Path::new(SHARED_LOG_DIR).to_path_buf()
}

fn safe_label_component(value: &str, fallback: &str) -> String {
    let mut sanitized: String = value
        .chars()
        .map(|ch| match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '_' | '-' | '.' => ch,
            _ => '_',
        })
        .collect();
    if sanitized.trim_matches('_').is_empty() {
        sanitized = fallback.to_string();
    }
    sanitized
}

fn printer_spool_override() -> Option<PathBuf> {
    env_string("LABEL_PRINTER_PIPE")
        .or_else(|| env_string("LABEL_PRINTER_SPOOL"))
        .map(PathBuf::from)
}

fn write_printer_spool(path: &Path, data: &[u8]) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        ensure_directory(parent)?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| AppError::Io(format!("Unable to open spool file: {err}")))?;
    file.write_all(data)
        .map_err(|err| AppError::Io(format!("Unable to write spool file: {err}")))?;
    file.write_all(b"\n")
        .map_err(|err| AppError::Io(format!("Unable to finalize spool file: {err}")))?;
    Ok(())
}

fn combine_messages(primary: Option<String>, warning: Option<String>) -> Option<String> {
    match (primary, warning) {
        (Some(mut base), Some(warn)) if !warn.is_empty() => {
            if !base.ends_with('.') {
                base.push('.');
            }
            base.push(' ');
            base.push_str(&warn);
            Some(base)
        }
        (None, Some(warn)) => Some(warn),
        (msg, None) => msg,
        (Some(base), Some(_)) => Some(base),
    }
}

fn make_label_id() -> String {
    let now = Local::now();
    let timestamp = now.format("%y%m%d%H%M%S").to_string();
    let mut rng = rand::thread_rng();
    let suffix: u32 = rng.sample(Uniform::new(0u32, 100_000));
    format!("{timestamp}{suffix:05}")
}

fn mm_to_px(mm: f32) -> u32 {
    const DPI: f32 = LABEL_DPI;
    ((mm * DPI) / 25.4).round().max(1.0) as u32
}

fn measure_text_width(font: &FontRef<'_>, scale: PxScale, text: &str) -> f32 {
    let scaled = font.as_scaled(scale);
    let mut width = 0.0;
    let mut prev = None;
    for ch in text.chars() {
        let glyph = scaled.scaled_glyph(ch);
        if let Some(prev_id) = prev {
            width += scaled.kern(prev_id, glyph.id);
        }
        width += scaled.h_advance(glyph.id);
        prev = Some(glyph.id);
    }
    width
}

#[derive(Debug, Clone)]
struct LabelDisplayValues {
    product: String,
    lot: String,
    length: String,
    quantity: String,
    coil: String,
    client: String,
    machine: String,
    operator: String,
    date: String,
}

fn build_label_display_values(
    product_ref: &str,
    of_id: &str,
    ref_coil: &str,
    length: Option<i32>,
    quantity: i32,
    operator_id: &str,
    machine_name: &str,
) -> LabelDisplayValues {
    let product_display = if product_ref.trim().is_empty() {
        "-".to_string()
    } else {
        product_ref.trim().to_string()
    };
    let lot_display = if of_id.trim().is_empty() {
        "-".to_string()
    } else {
        of_id.trim().to_string()
    };
    let length_display = length
        .map(|value| value.to_string())
        .unwrap_or_else(|| "-".to_string());
    let client_env = env_string("CLIENT_NAME").unwrap_or_default();
    let client_display = if client_env.trim().is_empty() {
        "-".to_string()
    } else {
        client_env.trim().to_string()
    };
    let machine_display = if machine_name.trim().is_empty() {
        "-".to_string()
    } else {
        machine_name.trim().to_string()
    };
    let operator_display = if operator_id.trim().is_empty() {
        "-".to_string()
    } else {
        operator_id.trim().to_string()
    };
    let coil_display = if ref_coil.trim().is_empty() {
        "-".to_string()
    } else {
        ref_coil.trim().to_string()
    };
    let quantity_display = quantity.to_string();
    let date_display = Local::now().format("%d.%m.%Y").to_string();

    LabelDisplayValues {
        product: product_display,
        lot: lot_display,
        length: length_display,
        quantity: quantity_display,
        coil: coil_display,
        client: client_display,
        machine: machine_display,
        operator: operator_display,
        date: date_display,
    }
}

fn sanitize_tspl_value(value: &str) -> String {
    value
        .replace(['\r', '\n'], " ")
        .replace('"', "'")
        .trim()
        .to_string()
}

static TSPL_TEMPLATE: once_cell::sync::Lazy<String> = once_cell::sync::Lazy::new(|| {
    let raw = include_str!("../assets/ticket.tspl");
    let mut lines = Vec::new();
    for raw_line in raw.lines() {
        let trimmed = raw_line.trim_start();
        if trimmed.starts_with('#') || trimmed.starts_with("//") {
            continue;
        }
        lines.push(raw_line.trim_end_matches('\r').to_string());
    }
    let result = lines.join("\n");
    // DEBUG: Print template to verify it's loaded correctly
    logging::log_info(&format!("TSPL Template loaded. QR line: {}", 
        result.lines().find(|l| l.contains("QRCODE")).unwrap_or("NOT FOUND")));
    result
});

fn build_tspl_replacements(
    displays: &LabelDisplayValues,
    payload: &BundleLabelRequest,
    product_ref: &str,
    machine_name: &str,
    operator_id: &str,
    barcode_value: &str,
    label_marking: &str,
    label_id: &str,
) -> HashMap<&'static str, String> {
    let now = Local::now();
    let mut values: HashMap<&'static str, String> = HashMap::with_capacity(24);
    values.insert("PRODUCT", sanitize_tspl_value(&displays.product));
    values.insert("LOT", sanitize_tspl_value(&displays.lot));
    values.insert("LENGTH", sanitize_tspl_value(&displays.length));
    values.insert("LENGTH_MM", sanitize_tspl_value(&displays.length));
    values.insert("QUANTITY", sanitize_tspl_value(&displays.quantity));
    values.insert("COIL", sanitize_tspl_value(&displays.coil));
    values.insert("CLIENT", sanitize_tspl_value(&displays.client));
    values.insert("MACHINE", sanitize_tspl_value(machine_name));
    values.insert("MACHINE_DISPLAY", sanitize_tspl_value(&displays.machine));
    values.insert("OPERATOR", sanitize_tspl_value(operator_id));
    values.insert("OPERATOR_DISPLAY", sanitize_tspl_value(&displays.operator));
    values.insert("DATE", sanitize_tspl_value(&displays.date));
    values.insert("DATE_ISO", now.format("%Y-%m-%d").to_string());
    values.insert("TIME", now.format("%H:%M").to_string());
    values.insert("TIME_ISO", now.format("%H:%M:%S").to_string());
    values.insert("DATETIME", now.format("%Y-%m-%d %H:%M:%S").to_string());
    values.insert("TIMESTAMP", now.format("%Y%m%d%H%M%S").to_string());
    values.insert("PRODUCT_REF", sanitize_tspl_value(product_ref));
    values.insert("OF", sanitize_tspl_value(payload.of_id.trim()));
    values.insert("WIRE", sanitize_tspl_value(payload.ref_wire.trim()));
    values.insert("MARQUAGE", sanitize_tspl_value(label_marking));
    values.insert("BARCODE", sanitize_tspl_value(barcode_value));
    values.insert(
        "LENGTH_RAW",
        payload
            .length_mm
            .map(|value| value.to_string())
            .unwrap_or_else(|| "".to_string()),
    );
    values.insert("QUANTITY_RAW", payload.quantity.to_string());
    values.insert("COIL_RAW", sanitize_tspl_value(payload.ref_coil.trim()));
    values.insert("LABEL_ID", sanitize_tspl_value(label_id));
    values
}

fn render_tspl_commands(tspl: &TsplSettings, replacements: &HashMap<&str, String>) -> String {
    let width_in = tspl.width_mm / 25.4;
    let height_in = tspl.height_mm / 25.4;
    let gap_in = tspl.gap_mm / 25.4;
    let mut header = format!(
        "SIZE {:.3},{:.3}\r\nGAP {:.3},0\r\nSPEED {}\r\nDENSITY {}\r\nDIRECTION {}\r\n",
        width_in, height_in, gap_in, tspl.speed, tspl.density, tspl.direction,
    );

    let mut body = TSPL_TEMPLATE.clone();
    for (key, value) in replacements {
        let placeholder = format!("{{{{{key}}}}}");
        body = body.replace(&placeholder, value);
    }

    let mut normalized = String::new();
    for (index, line) in body.lines().enumerate() {
        if index > 0 {
            normalized.push_str("\r\n");
        }
        normalized.push_str(line.trim_end());
    }
    normalized.push_str("\r\n");
    header.push_str(&normalized);
    header
}

fn compose_label_image(
    product_ref: &str,
    of_id: &str,
    ref_coil: &str,
    length: Option<i32>,
    quantity: i32,
    operator_id: &str,
    machine_name: &str,
    barcode_value: &str,
) -> Result<(ImageBuffer<Luma<u8>, Vec<u8>>, String), AppError> {
    const BORDER: u32 = 3;
    const PADDING_MM: f32 = 3.0;
    const GAP_MM: f32 = 2.0;
    const COLUMN_GAP_MM: f32 = 3.0;

    let width = mm_to_px(LABEL_WIDTH_MM);
    let height = mm_to_px(LABEL_HEIGHT_MM);
    let padding = mm_to_px(PADDING_MM);
    let gap = mm_to_px(GAP_MM);
    let column_gap = mm_to_px(COLUMN_GAP_MM);

    let mut image = ImageBuffer::<Luma<u8>, Vec<u8>>::from_pixel(width, height, Luma([255u8]));

    // outer border
    for x in 0..width {
        for y in 0..BORDER {
            image.put_pixel(x, y, Luma([0]));
            image.put_pixel(x, height - 1 - y, Luma([0]));
        }
    }
    for y in 0..height {
        for x in 0..BORDER {
            image.put_pixel(x, y, Luma([0]));
            image.put_pixel(width - 1 - x, y, Luma([0]));
        }
    }

    let left = padding + BORDER;
    let top = padding + BORDER;
    let right = width - padding - BORDER;
    let bottom = height - padding - BORDER;

    let inner_height = bottom - top;
    // QR CODE SIZE CONFIGURATION
    // Increased padding to make QR code smaller and improve scannability
    // Original: 2.0mm | Updated: 4.0mm for better edge clearance
    let qr_padding = mm_to_px(4.0); // Add 4mm padding around QR code
    let qr_size = inner_height.saturating_sub(qr_padding * 2);
    let qr_right = right.saturating_sub(qr_padding);
    let qr_left = qr_right - qr_size;

    let content_left = left;
    let content_right = qr_left.saturating_sub(gap);
    let content_width = content_right.saturating_sub(content_left);
    let column_width = (content_width.saturating_sub(column_gap)) / 2;
    let left_col_x = content_left;
    let right_col_x = content_left + column_width + column_gap;

    let displays = build_label_display_values(
        product_ref,
        of_id,
        ref_coil,
        length,
        quantity,
        operator_id,
        machine_name,
    );

    let rows: Vec<(Option<(&str, String)>, Option<(&str, String)>)> = vec![
        (
            Some(("Produit", displays.product.clone())),
            Some(("Client", displays.client.clone())),
        ),
        (
            Some(("Lot", displays.lot.clone())),
            Some(("Machine", displays.machine.clone())),
        ),
        (
            Some(("Long(mm)", displays.length.clone())),
            Some(("Operateur", displays.operator.clone())),
        ),
        (
            Some(("BOT", displays.quantity.clone())),
            Some(("Coil ref", displays.coil.clone())),
        ),
        (Some(("Date", displays.date.clone())), None),
    ];

    let font = font();
    let mut size = (inner_height as f32 * 0.18).max(10.0);
    let mut text_scale = PxScale::from(size);
    let mut metrics = font.as_scaled(text_scale);
    let mut ascent = metrics.ascent();
    let mut descent = metrics.descent().abs();
    let mut line_height = ascent + descent + 2.0;

    let max_height = inner_height as f32;
    let line_count = rows.len() as f32;
    while (line_height * line_count + 4.0) > max_height && size > 10.0 {
        size -= 1.0;
        text_scale = PxScale::from(size);
        metrics = font.as_scaled(text_scale);
        ascent = metrics.ascent();
        descent = metrics.descent().abs();
        line_height = ascent + descent + 2.0;
    }

    let baseline_start =
        top as f32 + (inner_height as f32 - (line_height * line_count + 4.0)) / 2.0;
    let label_gap = mm_to_px(1.5) as f32;
    let left_label_width = rows
        .iter()
        .filter_map(|(left, _)| left.as_ref())
        .map(|(label, _)| measure_text_width(&font, text_scale, &format!("{label}:")))
        .fold(0.0, f32::max);
    let right_label_width = rows
        .iter()
        .filter_map(|(_, right)| right.as_ref())
        .map(|(label, _)| measure_text_width(&font, text_scale, &format!("{label}:")))
        .fold(0.0, f32::max);
    let left_value_x = (left_col_x as f32 + left_label_width + label_gap).round() as i32;
    let right_value_x = (right_col_x as f32 + right_label_width + label_gap).round() as i32;

    for (idx, (left, right)) in rows.iter().enumerate() {
        let y = baseline_start + line_height * idx as f32;
        if let Some((label, value)) = left {
            let label_text = format!("{label}:");
            draw_text_mut(
                &mut image,
                Luma([0]),
                left_col_x as i32,
                (y - ascent).round() as i32,
                text_scale,
                &font,
                &label_text,
            );
            draw_text_mut(
                &mut image,
                Luma([0]),
                left_value_x,
                (y - ascent).round() as i32,
                text_scale,
                &font,
                value,
            );
        }
        if let Some((label, value)) = right {
            let label_text = format!("{label}:");
            draw_text_mut(
                &mut image,
                Luma([0]),
                right_col_x as i32,
                (y - ascent).round() as i32,
                text_scale,
                &font,
                &label_text,
            );
            draw_text_mut(
                &mut image,
                Luma([0]),
                right_value_x,
                (y - ascent).round() as i32,
                text_scale,
                &font,
                value,
            );
        }
    }

    let qr_payload = if barcode_value.trim().is_empty() {
        if product_ref.trim().is_empty() {
            of_id
        } else {
            product_ref
        }
    } else {
        barcode_value
    };
    let qr_code = QrCode::new(qr_payload.as_bytes())
        .map_err(|err| AppError::Config(format!("Unable to generate QR code for label: {err}")))?;
    let module_count = qr_code.width() as u32;
    let module_scale = (qr_size / module_count).max(1);
    let qr_image = qr_code
        .render::<Luma<u8>>()
        .module_dimensions(module_scale, module_scale)
        .quiet_zone(true)  // Enable quiet zone for scanner compatibility
        .build();
    let offset_x = qr_left + (qr_size.saturating_sub(qr_image.width())) / 2;
    // Move QR code down by 1mm to prevent top edge cutoff
    let offset_y = top + qr_padding + (qr_size.saturating_sub(qr_image.height())) / 2 + mm_to_px(1.0);
    for (dx, dy, pixel) in qr_image.enumerate_pixels() {
        let target_x = offset_x + dx;
        let target_y = offset_y + dy;
        if target_x < width && target_y < height {
            image.put_pixel(target_x, target_y, *pixel);
        }
    }

    let label_id = make_label_id();
    Ok((image, label_id))
}

fn generate_label_image(
    product_ref: &str,
    of_id: &str,
    ref_coil: &str,
    length: Option<i32>,
    quantity: i32,
    operator_id: &str,
    machine_name: &str,
    barcode_value: &str,
    marking: &str,
) -> Result<(PathBuf, String), AppError> {
    let (image, label_id) = compose_label_image(
        product_ref,
        of_id,
        ref_coil,
        length,
        quantity,
        operator_id,
        machine_name,
        barcode_value,
    )?;

    let output_dir = base_output_dir();
    ensure_directory(&output_dir)?;
    let safe_of_id = safe_label_component(of_id, "of");
    let safe_product = safe_label_component(product_ref, "product");
    let safe_marking = safe_label_component(marking, "marquage");
    let path = output_dir.join(format!("{safe_of_id}_{safe_product}_{safe_marking}.png"));
    image.save(&path)?;
    logging::log_info(&format!("Label image generated at {}", path.display()));

    Ok((path, label_id))
}

fn generate_label_pdf(
    product_ref: &str,
    of_id: &str,
    ref_coil: &str,
    length: Option<i32>,
    quantity: i32,
    operator_id: &str,
    machine_name: &str,
    barcode_value: &str,
    marking: &str,
) -> Result<(PathBuf, String), AppError> {
    let (image_path, label_id) = generate_label_image(
        product_ref,
        of_id,
        ref_coil,
        length,
        quantity,
        operator_id,
        machine_name,
        barcode_value,
        marking,
    )?;

    let image_bytes = fs::read(&image_path).map_err(|err| {
        AppError::Io(format!(
            "Unable to load PNG label for PDF conversion: {err}"
        ))
    })?;

    let raw_image = RawImage::decode_from_bytes(&image_bytes, &mut Vec::new()).map_err(|err| {
        AppError::Io(format!(
            "Unable to decode PNG label for PDF conversion: {err}"
        ))
    })?;

    let mut doc = PdfDocument::new("Bundle Label");
    let image_id = doc.add_image(&raw_image);

    let page_width = Mm(LABEL_WIDTH_MM);
    let page_height = Mm(LABEL_HEIGHT_MM);
    let output_dir = base_output_dir();
    ensure_directory(&output_dir)?;
    let safe_of_id = safe_label_component(of_id, "of");
    let safe_product = safe_label_component(product_ref, "product");
    let safe_marking = safe_label_component(marking, "marquage");
    let pdf_path = output_dir.join(format!("{safe_of_id}_{safe_product}_{safe_marking}.pdf"));

    let dpi = LABEL_DPI;
    let base_width_pt = (raw_image.width as f32 / dpi) * 72.0;
    let base_height_pt = (raw_image.height as f32 / dpi) * 72.0;
    let page_width_pt = LABEL_WIDTH_MM / 25.4 * 72.0;
    let page_height_pt = LABEL_HEIGHT_MM / 25.4 * 72.0;
    let scale_x = if base_width_pt > 0.0 {
        page_width_pt / base_width_pt
    } else {
        1.0
    };
    let scale_y = if base_height_pt > 0.0 {
        page_height_pt / base_height_pt
    } else {
        1.0
    };

    let ops = vec![Op::UseXobject {
        id: image_id,
        transform: XObjectTransform {
            translate_x: Some(Pt(0.0)),
            translate_y: Some(Pt(0.0)),
            rotate: None,
            scale_x: Some(scale_x),
            scale_y: Some(scale_y),
            dpi: Some(dpi),
        },
    }];

    let page = PdfPage::new(page_width, page_height, ops);
    let mut warnings = Vec::new();
    let pdf_bytes = doc
        .with_pages(vec![page])
        .save(&PdfSaveOptions::default(), &mut warnings);
    fs::write(&pdf_path, pdf_bytes)?;
    logging::log_info(&format!("Label PDF generated at {}", pdf_path.display()));

    Ok((pdf_path, label_id))
}

#[cfg(windows)]
fn to_wide_chars(input: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(input)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(windows)]
fn default_printer() -> Result<Vec<u16>, AppError> {
    use windows::{core::PWSTR, Win32::Graphics::Printing::GetDefaultPrinterW};
    let mut required: u32 = 0;
    unsafe {
        GetDefaultPrinterW(PWSTR::null(), &mut required);
    }
    if required == 0 {
        return Err(AppError::Config(
            "No default printer configured on this system.".into(),
        ));
    }
    let mut buffer: Vec<u16> = vec![0; required as usize];
    let success = unsafe { GetDefaultPrinterW(PWSTR(buffer.as_mut_ptr()), &mut required) };
    if !success.as_bool() {
        return Err(AppError::Config(
            "Unable to resolve default printer.".into(),
        ));
    }
    Ok(buffer)
}

#[cfg(windows)]
fn send_raw_to_printer(data: &[u8], printer_name: Option<&str>) -> Result<(), AppError> {
    if let Some(path) = printer_spool_override() {
        write_printer_spool(&path, data)?;
        return Ok(());
    }
    use windows::{
        core::{PCWSTR, PWSTR},
        Win32::{
            Foundation::HANDLE,
            Graphics::Printing::{
                ClosePrinter, EndDocPrinter, EndPagePrinter, OpenPrinterW, StartDocPrinterW,
                StartPagePrinter, WritePrinter, DOC_INFO_1W,
            },
        },
    };

    let printer_buffer = if let Some(name) = printer_name {
        if name.trim().is_empty() {
            default_printer()?
        } else {
            to_wide_chars(name)
        }
    } else {
        default_printer()?
    };

    let printer_ptr = PCWSTR(printer_buffer.as_ptr());

    let mut handle = HANDLE::default();
    unsafe {
        OpenPrinterW(printer_ptr, &mut handle, None).map_err(|err| {
            AppError::Config(format!(
                "Unable to open printer handle for label printing: {err}"
            ))
        })?;
    }
    if handle.is_invalid() {
        return Err(AppError::Config(
            "Unable to open printer handle for label printing.".into(),
        ));
    }

    let mut doc_name = to_wide_chars("CrimpQC Label");
    let mut doc_type = to_wide_chars("RAW");
    let doc_info = DOC_INFO_1W {
        pDocName: PWSTR(doc_name.as_mut_ptr()),
        pOutputFile: PWSTR::null(),
        pDatatype: PWSTR(doc_type.as_mut_ptr()),
    };

    unsafe {
        if StartDocPrinterW(handle, 1, &doc_info) == 0 {
            let _ = ClosePrinter(handle);
            return Err(AppError::Config(
                "Unable to start printer document for label.".into(),
            ));
        }
        if !StartPagePrinter(handle).as_bool() {
            EndDocPrinter(handle);
            let _ = ClosePrinter(handle);
            return Err(AppError::Config(
                "Unable to open printer page for label.".into(),
            ));
        }
        let mut written: u32 = 0;
        if !WritePrinter(
            handle,
            data.as_ptr() as *const c_void,
            data.len() as u32,
            &mut written,
        )
        .as_bool()
        {
            EndPagePrinter(handle);
            EndDocPrinter(handle);
            let _ = ClosePrinter(handle);
            return Err(AppError::Config(
                "Printer rejected label payload. Verify printer configuration.".into(),
            ));
        }
        EndPagePrinter(handle);
        EndDocPrinter(handle);
        let _ = ClosePrinter(handle);
    }

    Ok(())
}

#[cfg(not(windows))]
fn send_raw_to_printer(_data: &[u8], _printer_name: Option<&str>) -> Result<(), AppError> {
    if let Some(path) = printer_spool_override() {
        write_printer_spool(&path, _data)?;
        return Ok(());
    }
    Err(AppError::Config(
        "Direct label printing is only supported on Windows.".into(),
    ))
}

#[cfg(windows)]
pub fn list_system_printers() -> Result<Vec<String>, AppError> {
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Printing::{
        EnumPrintersW, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL, PRINTER_INFO_2W,
    };

    let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
    let mut needed = 0u32;
    let mut returned = 0u32;
    unsafe {
        match EnumPrintersW(flags, PCWSTR::null(), 2, None, &mut needed, &mut returned) {
            Ok(_) => {}
            Err(err) => {
                use windows::Win32::Foundation::{GetLastError, ERROR_INSUFFICIENT_BUFFER};
                let last_error = GetLastError();
                if last_error != ERROR_INSUFFICIENT_BUFFER || needed == 0 {
                    return Err(AppError::Config(format!(
                        "Unable to enumerate printers: {err}"
                    )));
                }
            }
        }
    }
    if needed == 0 {
        return Ok(vec![]);
    }
    let mut buffer: Vec<u8> = vec![0; needed as usize];
    unsafe {
        EnumPrintersW(
            flags,
            PCWSTR::null(),
            2,
            Some(buffer.as_mut_slice()),
            &mut needed,
            &mut returned,
        )
        .map_err(|err| {
            AppError::Config(format!(
                "Unable to enumerate printers on this system: {err}",
            ))
        })?;
    }
    let mut names = Vec::with_capacity(returned as usize);
    let ptr = buffer.as_ptr() as *const PRINTER_INFO_2W;
    for index in 0..returned {
        let info = unsafe { &*ptr.add(index as usize) };
        let name_ptr = info.pPrinterName;
        if name_ptr.is_null() {
            continue;
        }
        let name = unsafe { name_ptr.to_string() }
            .map_err(|err| AppError::Config(format!("Failed to read printer name: {err}")))?;
        if !name.trim().is_empty() {
            names.push(name);
        }
    }
    Ok(names)
}

#[cfg(not(windows))]
pub fn list_system_printers() -> Result<Vec<String>, AppError> {
    Ok(vec![])
}

fn normalize_format(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "" => None,
        "direct" | "pdf" | "png" | "image" | "img" => Some(normalized),
        _ => None,
    }
}

fn format_requires_printer(format: &str) -> bool {
    matches!(format, "direct")
}

pub fn load_label_printer_settings(
    state: &AppState,
) -> Result<LabelPrinterSettingsResponse, AppError> {
    let snapshot = current_session_snapshot(state)?;
    let (user_settings, _) =
        fetch_printer_settings_or_default(state, &snapshot.user_id, &snapshot.operator_id);
    let default_format = resolve_default_format();
    let resolved_format = user_settings
        .format
        .clone()
        .or_else(|| default_format.clone())
        .unwrap_or_else(|| "pdf".into());
    let tspl_settings = resolve_tspl_settings(&user_settings);

    Ok(LabelPrinterSettingsResponse {
        enabled: label_printing_enabled(),
        label_format: user_settings.format.clone(),
        label_printer_name: user_settings.printer_name.clone(),
        default_format,
        resolved_format: Some(resolved_format),
        tspl_settings,
    })
}

pub fn save_label_printer_settings(
    state: &AppState,
    payload: SaveLabelPrinterSettingsRequest,
) -> Result<LabelPrinterSettingsResponse, AppError> {
    let format = normalize_format(&payload.label_format)
        .ok_or_else(|| AppError::Config("Unsupported label format.".into()))?;
    let printer_name = payload
        .label_printer_name
        .as_ref()
        .map(|name| name.trim())
        .filter(|name| !name.is_empty())
        .map(|name| name.to_string());
    if format_requires_printer(&format) && printer_name.is_none() {
        return Err(AppError::Config(
            "Select a printer when using direct label printing.".into(),
        ));
    }

    let tspl_settings = match payload.tspl_settings {
        Some(ref values) => normalize_tspl_settings(values)?,
        None => default_tspl_settings(),
    };

    let snapshot = current_session_snapshot(state)?;
    let db_result = state.app_pool().and_then(|pool| {
        pool.get_conn()
            .map_err(AppError::from)
            .and_then(|mut conn| {
                upsert_user_printer_settings(
                    &mut conn,
                    &snapshot.user_id,
                    &snapshot.operator_id,
                    &format,
                    printer_name.as_deref(),
                    &tspl_settings,
                )
            })
    });

    if let Err(err) = db_result {
        logging::log_warn(&format!(
            "Falling back to cached printer settings for {}/{}: {}",
            snapshot.user_id, snapshot.operator_id, err
        ));
        save_cached_printer_settings(
            &snapshot.user_id,
            &snapshot.operator_id,
            &format,
            printer_name.as_deref(),
            &tspl_settings,
        )?;
    } else {
        return load_label_printer_settings(state);
    }

    load_label_printer_settings(state)
}

pub fn print_bundle_label(
    state: &AppState,
    payload: BundleLabelRequest,
) -> Result<BundleLabelResult, AppError> {
    let order_context = format!(
        "OF {} / Wire {}",
        payload.of_id.trim(),
        payload.ref_wire.trim()
    );
    logging::log_info(&format!(
        "Bundle label requested for {} quantity {} (machine {:?})",
        order_context,
        payload.quantity,
        payload
            .machine_name
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
    ));
    if !label_printing_enabled() {
        logging::log_info("Bundle label request skipped: label printing disabled");
        return Ok(BundleLabelResult {
            format: "disabled".into(),
            label_id: String::new(),
            path: None,
            printer_name: None,
            skipped: true,
            message: Some("Label printing disabled via configuration.".into()),
        });
    }

    let snapshot = current_session_snapshot(state)?;
    let (user_settings, settings_warning) =
        fetch_printer_settings_or_default(state, &snapshot.user_id, &snapshot.operator_id);

    let format = resolve_default_format()
        .or_else(|| user_settings.format.clone())
        .unwrap_or_else(|| "pdf".into());
    let format = normalize_format(&format).unwrap_or_else(|| "pdf".into());
    let printer_name = user_settings
        .printer_name
        .clone()
        .or_else(|| env_string("LABEL_PRINTER_NAME"));
    let tspl_settings = resolve_tspl_settings(&user_settings);

    let requires_printer = format_requires_printer(&format);
    if requires_printer
        && printer_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_none()
    {
        return Err(AppError::Config(
            "Configure a printer before printing bundle labels.".into(),
        ));
    }

    if payload.quantity <= 0 {
        return Err(AppError::Config(
            "Bundle quantity must be a positive number.".into(),
        ));
    }

    let machine_name = payload
        .machine_name
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or(snapshot.machine_id.clone())
        .or_else(|| env_string("ENGINE_NAME"))
        .unwrap_or_default();

    let trimmed_product = payload.product_ref.trim();
    let product_ref = if trimmed_product.is_empty() {
        let trimmed_of = payload.of_id.trim();
        if trimmed_of.is_empty() {
            payload.ref_wire.trim().to_string()
        } else {
            trimmed_of.to_string()
        }
    } else {
        trimmed_product.to_string()
    };

    let barcode_value = payload
        .marquage
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            let trimmed_ref_wire = payload.ref_wire.trim();
            if !trimmed_ref_wire.is_empty() {
                trimmed_ref_wire.to_string()
            } else {
                product_ref.clone()
            }
        });

    let label_marking = payload
        .marquage
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| payload.ref_wire.as_str());

    let result = match format.as_str() {
        "direct" => {
            let label_id = make_label_id();
            let displays = build_label_display_values(
                &product_ref,
                &payload.of_id,
                &payload.ref_coil,
                payload.length_mm,
                payload.quantity,
                &snapshot.operator_id,
                &machine_name,
            );
            let replacements = build_tspl_replacements(
                &displays,
                &payload,
                &product_ref,
                &machine_name,
                &snapshot.operator_id,
                &barcode_value,
                label_marking,
                &label_id,
            );
            let commands = render_tspl_commands(&tspl_settings, &replacements);
            send_raw_to_printer(commands.as_bytes(), printer_name.as_deref())?;
            BundleLabelResult {
                format: format.clone(),
                label_id,
                path: None,
                printer_name: printer_name.clone(),
                skipped: false,
                message: combine_messages(
                    Some("Label sent to printer queue.".into()),
                    settings_warning.clone(),
                ),
            }
        }
        "png" | "image" | "img" => {
            let (path, label_id) = generate_label_image(
                &product_ref,
                &payload.of_id,
                &payload.ref_coil,
                payload.length_mm,
                payload.quantity,
                &snapshot.operator_id,
                &machine_name,
                &barcode_value,
                label_marking,
            )?;
            BundleLabelResult {
                format: format.clone(),
                label_id,
                path: Some(path.to_string_lossy().to_string()),
                printer_name,
                skipped: false,
                message: combine_messages(
                    Some("Label image generated.".into()),
                    settings_warning.clone(),
                ),
            }
        }
        _ => {
            let (path, label_id) = generate_label_pdf(
                &product_ref,
                &payload.of_id,
                &payload.ref_coil,
                payload.length_mm,
                payload.quantity,
                &snapshot.operator_id,
                &machine_name,
                &barcode_value,
                label_marking,
            )?;
            BundleLabelResult {
                format: "pdf".into(),
                label_id,
                path: Some(path.to_string_lossy().to_string()),
                printer_name,
                skipped: false,
                message: combine_messages(Some("Label PDF generated.".into()), settings_warning),
            }
        }
    };

    logging::log_info(&format!(
        "Bundle label generated ({}) for {} -> label {}",
        result.format, order_context, result.label_id
    ));

    if !result.skipped {
        let pool = state.app_pool()?;
        let mut conn = pool.get_conn()?;
        ensure_logging_tables(&mut conn)?;
        insert_session_log(
            &mut conn,
            &snapshot,
            "LABEL",
            &format!("Label printed ({})", result.format.to_uppercase()),
            Some(payload.of_id.as_str()),
            Some(product_ref.as_str()),
            Some(payload.ref_wire.as_str()),
            if payload.ref_coil.trim().is_empty() {
                None
            } else {
                Some(payload.ref_coil.as_str())
            },
            Some(payload.quantity as f64),
            Some(result.label_id.as_str()),
            None,
            result.path.as_deref(),
        )?;
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::load_env_lenient;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    static ENV_GUARD: once_cell::sync::Lazy<Mutex<()>> =
        once_cell::sync::Lazy::new(|| Mutex::new(()));

    #[test]
    fn embedded_font_is_available() {
        assert!(
            !FONT_BYTES.is_empty(),
            "embedded font bytes should be present"
        );
        let font = font();
        let units_per_em = font
            .units_per_em()
            .expect("embedded font should expose font metrics");
        assert!(
            units_per_em > 0.0,
            "embedded font should expose font metrics"
        );
    }

    #[test]
    fn render_tspl_commands_applies_template_placeholders() {
        let tspl = TsplSettings {
            width_mm: 100.0,
            height_mm: 18.0,
            gap_mm: 2.0,
            speed: 5,
            density: 9,
            direction: 0,
        };
        let displays = LabelDisplayValues {
            product: "Widget".into(),
            lot: "LOT-42".into(),
            length: "1200".into(),
            quantity: "5".into(),
            coil: "C-10".into(),
            client: "ClientX".into(),
            machine: "CELL-1".into(),
            operator: "OP-1".into(),
            date: "01.01.2024".into(),
        };
        let payload = BundleLabelRequest {
            product_ref: "REF-9000".into(),
            of_id: "OF-22".into(),
            ref_wire: "WIRE-A".into(),
            ref_coil: "C-10".into(),
            marquage: Some("WIRE-A".into()),
            quantity: 5,
            length_mm: Some(1200),
            machine_name: Some("CELL-1".into()),
        };
        let replacements = build_tspl_replacements(
            &displays,
            &payload,
            "REF-9000",
            "CELL-1",
            "OP-1",
            "CODE-12345",
            "WIRE-A",
            "LBL-9001",
        );

        let commands = render_tspl_commands(&tspl, &replacements);

        let expected_header =
            "SIZE 3.937,0.709\r\nGAP 0.079,0\r\nSPEED 5\r\nDENSITY 9\r\nDIRECTION 0\r\n";
        assert!(
            commands.starts_with(expected_header),
            "TSPL header should convert millimetres to inches with CRLFs"
        );
        assert!(
            commands.contains("Widget"),
            "template body should include replaced product value"
        );
        assert!(
            commands.contains("CODE-12345"),
            "template body should include barcode value"
        );
        assert!(
            !commands.contains("{{"),
            "template placeholders should be fully replaced"
        );
        assert!(
            commands.ends_with("\r\n"),
            "rendered TSPL must terminate with CRLF"
        );
    }

    #[test]
    fn cached_printer_settings_round_trip() {
        let _guard = ENV_GUARD.lock().expect("env guard should lock");
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after unix epoch")
            .as_nanos();
        let base = std::env::temp_dir().join(format!("printer-settings-cache-{unique_suffix}"));
        if base.exists() {
            let _ = fs::remove_dir_all(&base);
        }
        fs::create_dir_all(&base).expect("temp cache directory should be created");
        let shared_path = base.to_string_lossy().to_string();
        std::env::set_var("SHARED_FOLDER", &shared_path);

        let tspl = TsplSettings {
            width_mm: 54.2,
            height_mm: 18.0,
            gap_mm: 1.2,
            speed: 6,
            density: 9,
            direction: 0,
        };

        save_cached_printer_settings("user-1", "operator-9", "direct", Some("ZebraGX"), &tspl)
            .expect("saving cached printer settings should succeed");
        let loaded = load_cached_printer_settings("user-1", "operator-9")
            .expect("loading cached printer settings should succeed")
            .expect("cached printer settings should exist");

        assert_eq!(loaded.format.as_deref(), Some("direct"));
        assert_eq!(loaded.printer_name.as_deref(), Some("ZebraGX"));
        let restored = loaded.tspl.expect("cached TSPL settings should be present");
        assert_eq!(restored.width_mm, tspl.width_mm);
        assert_eq!(restored.speed, tspl.speed);

        std::env::remove_var("SHARED_FOLDER");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn print_bundle_label_respects_disabled_flag() {
        let _guard = ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::env::set_var("ENABLE_LABEL_PRINTING", "false");
        std::env::set_var("VITE_ENABLE_LABEL_PRINTING", "false");
        let state = AppState::new().expect("state should initialize without DB");
        let payload = BundleLabelRequest {
            product_ref: "REF-123".to_string(),
            of_id: "OF-42".to_string(),
            ref_wire: "WIRE-1".to_string(),
            ref_coil: "COIL-A".to_string(),
            marquage: Some("MK-01".to_string()),
            quantity: 5,
            length_mm: Some(1200),
            machine_name: Some("Press-7".to_string()),
        };

        let result = print_bundle_label(&state, payload).expect("label generation should succeed");
        assert!(
            result.skipped,
            "expected printing to be skipped when disabled"
        );
        assert_eq!(result.format, "disabled");

        std::env::remove_var("ENABLE_LABEL_PRINTING");
        std::env::remove_var("VITE_ENABLE_LABEL_PRINTING");
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cableqc_{name}_{}", make_label_id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir should be created");
        dir
    }

    fn apply_env_file(root: &Path, entries: &[(&str, &str)]) -> Vec<String> {
        let env_path = root.join(".env.test");
        let mut content = String::new();
        let mut keys = Vec::with_capacity(entries.len());
        for (key, value) in entries {
            content.push_str(&format!("{key}={value}\n"));
            keys.push(key.to_string());
        }
        fs::write(&env_path, content).expect("env file should be written");
        load_env_lenient(&env_path).expect("env file should load");
        keys
    }

    fn cleanup_env(keys: &[String]) {
        for key in keys {
            std::env::remove_var(key);
        }
    }

    fn build_state() -> AppState {
        let state = AppState::new().expect("state should initialize");
        state.test_seed_session("user-test", "OP-7", Some("LINE-3"));
        state
    }

    #[test]
    fn generate_png_label_with_temp_env_and_safe_filename() {
        let _guard = ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = temp_dir("png");
        let shared_root = dir.join("shared");
        let spool = dir.join("spool.txt");
        let shared_value = shared_root.to_string_lossy().to_string();
        let entries = vec![("SHARED_FOLDER", shared_value.as_str())];
        let env_keys = apply_env_file(&dir, &entries);
        std::env::set_var("LABEL_FORMAT", "png");
        std::env::set_var("CLIENT_NAME", "Integration QA");
        std::env::set_var("LABEL_PRINTER_PIPE", spool.to_string_lossy().as_ref());

        let state = build_state();
        let payload = BundleLabelRequest {
            product_ref: "REF/ABC".to_string(),
            of_id: "OF:42".to_string(),
            ref_wire: "WIRE/ALT".to_string(),
            ref_coil: "COIL-1".to_string(),
            marquage: Some("MARQ:01".to_string()),
            quantity: 2,
            length_mm: Some(1500),
            machine_name: Some("Machine/Prime".to_string()),
        };

        let result = print_bundle_label(&state, payload).expect("png label should succeed");
        assert_eq!(result.format, "png");
        assert!(!result.skipped);
        let path = Path::new(result.path.as_ref().expect("path expected"));
        assert!(path.exists(), "label image should exist");
        let filename = path.file_name().unwrap().to_string_lossy().to_string();
        assert_eq!(filename, "OF_42_REF_ABC_MARQ_01.png");
        assert!(
            result
                .message
                .as_deref()
                .unwrap_or_default()
                .contains("Label image generated"),
            "should include success message"
        );

        cleanup_env(&env_keys);
        std::env::remove_var("LABEL_FORMAT");
        std::env::remove_var("CLIENT_NAME");
        std::env::remove_var("LABEL_PRINTER_PIPE");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn generate_pdf_label_when_db_unavailable() {
        let _guard = ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = temp_dir("pdf");
        let shared_root = dir.join("shared");
        let shared_value = shared_root.to_string_lossy().to_string();
        let entries = vec![("SHARED_FOLDER", shared_value.as_str())];
        let env_keys = apply_env_file(&dir, &entries);
        std::env::set_var("LABEL_FORMAT", "pdf");

        let state = build_state();
        let payload = BundleLabelRequest {
            product_ref: "REF-XYZ".to_string(),
            of_id: "OF/99".to_string(),
            ref_wire: "WIRE-2".to_string(),
            ref_coil: "COIL-2".to_string(),
            marquage: None,
            quantity: 4,
            length_mm: Some(800),
            machine_name: Some("Cell-A".to_string()),
        };

        let result = print_bundle_label(&state, payload).expect("pdf label should succeed");
        assert_eq!(result.format, "pdf");
        let path = Path::new(result.path.as_ref().expect("pdf path"));
        assert!(path.exists(), "PDF should be written");
        let filename = path.file_name().unwrap().to_string_lossy();
        assert_eq!(filename, "OF_99_REF-XYZ_WIRE-2.pdf");
        assert!(
            result
                .message
                .as_deref()
                .unwrap_or_default()
                .contains("Label PDF generated"),
            "should acknowledge pdf creation"
        );

        cleanup_env(&env_keys);
        std::env::remove_var("LABEL_FORMAT");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn direct_printing_spools_when_override_set() {
        let _guard = ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = temp_dir("direct");
        let shared_root = dir.join("shared");
        let spool_path = dir.join("spool.txt");
        let shared_value = shared_root.to_string_lossy().to_string();
        let entries = vec![("SHARED_FOLDER", shared_value.as_str())];
        let env_keys = apply_env_file(&dir, &entries);
        std::env::set_var("LABEL_FORMAT", "direct");
        std::env::set_var("LABEL_PRINTER_NAME", "QA-Printer");
        std::env::set_var("LABEL_PRINTER_PIPE", spool_path.to_string_lossy().as_ref());

        let state = build_state();
        let payload = BundleLabelRequest {
            product_ref: "".to_string(),
            of_id: "OF-777".to_string(),
            ref_wire: "WIRE-Z".to_string(),
            ref_coil: "COIL-Z".to_string(),
            marquage: None,
            quantity: 1,
            length_mm: Some(600),
            machine_name: Some("Cell-B".to_string()),
        };

        let result = print_bundle_label(&state, payload).expect("direct printing should spool");
        assert_eq!(result.format, "direct");
        assert!(!result.skipped);
        assert!(result.path.is_none());
        let contents = fs::read_to_string(&spool_path).expect("spool output readable");
        assert!(contents.contains("SIZE 3.937,0.709"));
        assert!(contents.contains("GAP 0.079,0"));
        assert!(contents.contains("TEXT 150,20,\"3\",0,0.8,0.8,\"OF-777\""));
        assert!(contents.contains("TEXT 470,20,\"3\",0,0.8,0.8,\"Cell-B\""));
        assert!(contents.contains("TEXT 470,45,\"3\",0,0.8,0.8,\"OP-7\""));
        assert!(contents.contains("TEXT 150,95,\"3\",0,0.8,0.8,\"1\""));
        let qrcode_line = contents
            .lines()
            .find(|line| line.contains("QRCODE 650,10"))
            .expect("qrcode command present for direct printing");
        assert!(qrcode_line.contains("WIRE-Z"));
        assert!(contents.contains("PRINT 1"));
        assert!(
            result
                .message
                .as_deref()
                .unwrap_or_default()
                .contains("Label sent to printer queue"),
            "should include queue message"
        );

        cleanup_env(&env_keys);
        std::env::remove_var("LABEL_FORMAT");
        std::env::remove_var("LABEL_PRINTER_NAME");
        std::env::remove_var("LABEL_PRINTER_PIPE");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn direct_printing_uses_marquage_for_barcode() {
        let _guard = ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = temp_dir("direct_marquage");
        let shared_root = dir.join("shared");
        let spool_path = dir.join("spool.txt");
        let shared_value = shared_root.to_string_lossy().to_string();
        let entries = vec![("SHARED_FOLDER", shared_value.as_str())];
        let env_keys = apply_env_file(&dir, &entries);
        std::env::set_var("LABEL_FORMAT", "direct");
        std::env::set_var("LABEL_PRINTER_NAME", "QA-Printer");
        std::env::set_var("LABEL_PRINTER_PIPE", spool_path.to_string_lossy().as_ref());

        let state = build_state();
        let payload = BundleLabelRequest {
            product_ref: "REF-900".to_string(),
            of_id: "OF-900".to_string(),
            ref_wire: "WIRE-900".to_string(),
            ref_coil: "COIL-900".to_string(),
            marquage: Some("MK-900".to_string()),
            quantity: 3,
            length_mm: Some(450),
            machine_name: Some("Cell-C".to_string()),
        };

        let result = print_bundle_label(&state, payload)
            .expect("direct printing should spool with marquage");
        assert_eq!(result.format, "direct");
        assert!(!result.skipped);
        let contents = fs::read_to_string(&spool_path).expect("spool output readable");
        assert!(contents.contains("TEXT 150,20,\"3\",0,0.8,0.8,\"REF-900\""));
        let qrcode_line = contents
            .lines()
            .find(|line| line.contains("QRCODE 650,10"))
            .expect("qrcode command present for direct printing");
        assert!(qrcode_line.contains("MK-900"));

        cleanup_env(&env_keys);
        std::env::remove_var("LABEL_FORMAT");
        std::env::remove_var("LABEL_PRINTER_NAME");
        std::env::remove_var("LABEL_PRINTER_PIPE");
        let _ = fs::remove_dir_all(dir);
    }
}
