#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use dotenvy::{dotenv, Error as DotenvError};
use hostname::get as hostname_get;
use image::ImageError;
use local_ip_address::local_ip;
use mysql::{params, prelude::Queryable, Error as MysqlError, Pool, PooledConn, Row, Value};
use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::{blocking::Client, Url};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    env,
    ffi::OsString,
    fs::{self, File},
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    sync::{Mutex, RwLock},
    time::{Duration, SystemTime},
};
use tauri::{Manager, State};
use thiserror::Error;

mod logging;
mod printing;
mod camera;
mod marker_printing;

// -------------------------------------------------------------------------------------------------
// Error handling
// -------------------------------------------------------------------------------------------------

#[derive(Error, Debug)]
pub(crate) enum AppError {
    #[error("configuration: {0}")]
    Config(String),
    #[error("io: {0}")]
    Io(String),
    #[error("network: {0}")]
    Network(String),
    #[error("csv: {0}")]
    Csv(String),
    #[error(transparent)]
    Mysql(#[from] mysql::Error),
}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        AppError::Io(value.to_string())
    }
}

impl From<ImageError> for AppError {
    fn from(value: ImageError) -> Self {
        AppError::Io(value.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(value: reqwest::Error) -> Self {
        AppError::Network(value.to_string())
    }
}

impl From<csv::Error> for AppError {
    fn from(value: csv::Error) -> Self {
        AppError::Csv(value.to_string())
    }
}

// -------------------------------------------------------------------------------------------------
// Environment helpers
// -------------------------------------------------------------------------------------------------

pub(crate) fn env_string(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

pub(crate) fn env_bool(key: &str, default: bool) -> bool {
    env_string(key)
        .map(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(default)
}

fn env_u16(key: &str, default: u16) -> u16 {
    env_string(key)
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(default)
}

pub(crate) fn resolve_engine_name() -> String {
    match local_ip() {
        Ok(ip) if !ip.is_unspecified() && !ip.is_loopback() => ip.to_string(),
        Ok(ip) => ip.to_string(),
        Err(_) => hostname_get()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "unknown-host".into()),
    }
}

fn env_f64(key: &str, default: f64) -> f64 {
    env_string(key)
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(default)
}

fn require_env(key: &str) -> Result<String, AppError> {
    env_string(key).ok_or_else(|| AppError::Config(format!("{key} is not configured")))
}

pub(crate) fn env_debug_enabled() -> bool {
    env::var("CLI_LOGIN_DEBUG").is_ok() || env::var("APP_DEBUG_ENV").is_ok()
}

fn env_flag(names: &[&str], default: bool) -> bool {
    let mut any_specified = false;
    for name in names {
        if let Some(value) = env_string(name) {
            any_specified = true;
            if matches!(
                value.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            ) {
                return true;
            }
        }
    }
    if any_specified {
        false
    } else {
        default
    }
}

pub(crate) fn load_env_lenient(path: &Path) -> io::Result<()> {
    let file = File::open(path)?;
    let reader = io::BufReader::new(file);
    for line_result in reader.lines() {
        let line = line_result?;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let mut parts = trimmed.splitn(2, '=');
        let key = parts.next().map(str::trim);
        let value = parts.next().unwrap_or("").trim();
        let Some(key) = key else { continue };
        if key.is_empty() {
            continue;
        }
        let value = if value.starts_with('"') && value.ends_with('"') && value.len() >= 2 {
            &value[1..value.len() - 1]
        } else {
            value
        };
        env::set_var(key, value);
    }
    Ok(())
}

fn load_env_file(path: &Path) {
    if !path.is_file() {
        return;
    }
    match dotenvy::from_path(path) {
        Ok(_) => {
            if env_debug_enabled() {
                println!("Loaded environment from {}", path.display());
            }
        }
        Err(err) if matches!(err, DotenvError::LineParse(_, _)) => match load_env_lenient(path) {
            Ok(_) => {
                if env_debug_enabled() {
                    println!(
                        "Loaded environment from {} using lenient parser",
                        path.display()
                    );
                }
            }
            Err(err) => {
                if env_debug_enabled() {
                    println!("Failed lenient parse for {}: {}", path.display(), err);
                }
            }
        },
        Err(err) => {
            if env_debug_enabled() {
                println!("Env load error ({}): {}", path.display(), err);
            }
        }
    }
}

fn preload_env() {
    dotenv().ok();
    load_env_file(Path::new(".env"));
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    load_env_file(&manifest_dir.join(".env"));
    load_env_file(&manifest_dir.join("..").join(".env"));
    if let Ok(exe_path) = env::current_exe() {
        if let Some(dir) = exe_path.parent() {
            load_env_file(&dir.join(".env"));
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FeatureFlagsResponse {
    crimp_test: bool,
    comparator_test: bool,
    microscope_test: bool,
    label_printing: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifyUserResponse {
    valid: bool,
    user_name: Option<String>,
    is_admin: bool,
    message: String,
}

// -------------------------------------------------------------------------------------------------
// External product API shapes
// -------------------------------------------------------------------------------------------------

#[derive(Debug, Deserialize, Serialize, Clone)]
struct ApiWireExt {
    terminal: Option<String>,
    joint: Option<String>,
    stripping: Option<f64>,
    #[serde(alias = "type")]
    kind: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct ApiWire {
    #[serde(rename = "ref_wire")]
    ref_wire: String,
    marquage: String,
    #[serde(rename = "lenght")]
    length: Option<f64>,
    #[serde(default)]
    ext1: Option<ApiWireExt>,
    #[serde(default)]
    ext2: Option<ApiWireExt>,
}

#[derive(Debug, Deserialize, Serialize)]
struct ApiCoil {
    #[serde(rename = "ref_coil")]
    ref_coil: String,
    name: Option<String>,
    section: Option<f64>,
    #[serde(rename = "color1")]
    color_primary: Option<String>,
    #[serde(rename = "color2")]
    color_secondary: Option<String>,
    #[serde(default)]
    wires: Vec<ApiWire>,
}
// -------------------------------------------------------------------------------------------------
// DB configuration
// -------------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct DbConfig {
    host: String,
    user: String,
    pass: String,
    name: String,
    port: u16,
    ssl_disabled: bool,
    connect_timeout: Duration,
}

impl DbConfig {
    fn from_env(prefix: &str) -> Result<Self, AppError> {
        let host = require_env(&format!("{prefix}_HOST"))?;
        let user = require_env(&format!("{prefix}_USER"))?;
        let pass = require_env(&format!("{prefix}_PASS"))?;
        let name = require_env(&format!("{prefix}_NAME"))?;
        let port = env_u16(&format!("{prefix}_PORT"), 3306);
        let ssl_disabled = env_bool(&format!("{prefix}_SSL_DISABLED"), false);
        let connect_timeout_secs = env_f64(&format!("{prefix}_CONN_TIMEOUT"), 6.0).clamp(1.0, 60.0);
        Ok(Self {
            host,
            user,
            pass,
            name,
            port,
            ssl_disabled,
            connect_timeout: Duration::from_secs_f64(connect_timeout_secs),
        })
    }

    fn create_pool(&self) -> Result<Pool, AppError> {
        let mut builder = mysql::OptsBuilder::new();
        builder = builder
            .ip_or_hostname(Some(self.host.as_str()))
            .tcp_port(self.port)
            .user(Some(self.user.as_str()))
            .pass(Some(self.pass.as_str()))
            .db_name(Some(self.name.as_str()))
            .stmt_cache_size(Some(32))
            .tcp_connect_timeout(Some(self.connect_timeout))
            .read_timeout(Some(Duration::from_secs(10)))
            .write_timeout(Some(Duration::from_secs(10)));
        if self.ssl_disabled {
            builder = builder.ssl_opts(None);
        }

        let opts = mysql::Opts::from(builder);
        Pool::new(opts).map_err(AppError::from)
    }
}
// -------------------------------------------------------------------------------------------------
// Application configuration (env snapshot)
// -------------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct AppConfig {
    app_db: Option<DbConfig>,
    crimp_db: Option<DbConfig>,
    shared_folder: Option<PathBuf>,
    user_list_path: Option<PathBuf>,
    master_host: Option<String>,
    userlist_url: Option<String>,
    admin_userlist_url: Option<String>,
    admin_env_url: Option<String>,
    api_base_url: Option<String>,
    admin_api_base_url: Option<String>,
    microscope_photo_dir: Option<PathBuf>,
}

impl AppConfig {
    fn load() -> Self {
        let shared_folder = env_string("SHARED_FOLDER")
            .or_else(|| env_string("shared_folder"))
            .or_else(|| env_string("NETWORK_PHOTO_SHARE"))
            .map(PathBuf::from);
        let user_list_path = env_string("USER_LIST_DIR").map(PathBuf::from);
        let microscope_photo_dir = env_string("MICROSCOPE_PHOTO_DIR").map(PathBuf::from);
        let master_host = env_string("MASTER_HOST");
        let userlist_url = env_string("USERLIST_URL");
        let admin_userlist_url = env_string("ADMIN_USERLIST_URL");
        let admin_env_url = env_string("ADMIN_ENV_URL").or_else(|| env_string("ADMINENV_URL"));
        let api_base_url = env_string("API_BASE_URL");
        let admin_api_base_url = env_string("ADMIN_API_BASE_URL");
        Self {
            app_db: DbConfig::from_env("APP_DB").ok(),
            crimp_db: DbConfig::from_env("CRIMP_DB").ok(),
            shared_folder,
            user_list_path,
            master_host,
            userlist_url,
            admin_userlist_url,
            admin_env_url,
            api_base_url,
            admin_api_base_url,
            microscope_photo_dir,
        }
    }
}

pub(crate) const SHARED_LOG_DIR: &str = "logs";
pub(crate) const SHARED_IMAGES_DIR: &str = "shared_image";
pub(crate) const SHARED_IMAGES_LEGACY_DIR: &str = "shared_images";
pub(crate) const SHARED_MICROSCOPE_DIR: &str = "microscope";
pub(crate) const SHARED_OPERATOR_DIR: &str = "operator";
pub(crate) const SHARED_QUALITY_DIR: &str = "quality";
pub(crate) const SHARED_PDF_DIR: &str = "pdf_labels";

fn ensure_shared_directories(config: &AppConfig) -> Result<(), AppError> {
    if let Some(root) = &config.shared_folder {
        fs::create_dir_all(root)?;
        let logs_dir = root.join(SHARED_LOG_DIR);
        let pdf_dir = root.join(SHARED_PDF_DIR);
        let shared_dir = root.join(SHARED_IMAGES_DIR);
        let operator_dir = shared_dir.join(SHARED_OPERATOR_DIR);
        let quality_dir = shared_dir.join(SHARED_QUALITY_DIR);
        let microscope_dir = root.join(SHARED_MICROSCOPE_DIR);

        for dir in [
            &logs_dir,
            &pdf_dir,
            &shared_dir,
            &operator_dir,
            &quality_dir,
            &microscope_dir,
        ] {
            fs::create_dir_all(dir)?;
        }

        let app_log = logs_dir.join("app.log");
        let error_log = logs_dir.join("error.log");
        logging::configure(logs_dir.clone(), app_log, error_log)?;
        logging::log_info(&format!("Shared resources available at {}", root.display()));
    } else {
        let fallback = PathBuf::from(SHARED_LOG_DIR);
        fs::create_dir_all(&fallback)?;
        let app_log = fallback.join("app.log");
        let error_log = fallback.join("error.log");
        logging::configure(fallback, app_log, error_log)?;
        logging::log_warn("Shared folder not configured; logging to local logs directory.");
    }
    Ok(())
}
// -------------------------------------------------------------------------------------------------
// Session state
// -------------------------------------------------------------------------------------------------

#[derive(Clone, Default)]
struct SessionState {
    user_id: Option<String>,
    user_name: Option<String>,
    role: Option<String>,
    operator_id: Option<String>,
    operator_name: Option<String>,
    machine_id: Option<String>,
    user_list_path: Option<PathBuf>,
    active_orders: HashSet<String>,
}

#[derive(Clone)]
#[allow(dead_code)]
pub(crate) struct SessionSnapshot {
    pub user_id: String,
    pub user_name: Option<String>,
    pub role: String,
    pub operator_id: String,
    pub operator_name: Option<String>,
    pub machine_id: Option<String>,
    pub active_orders: HashSet<String>,
}

pub(crate) fn current_session_snapshot(state: &AppState) -> Result<SessionSnapshot, AppError> {
    let session = state.session.lock().expect("session lock poisoned");
    let user_id = session
        .user_id
        .clone()
        .ok_or_else(|| AppError::Config("User session not initialized.".into()))?;
    let operator_id = session
        .operator_id
        .clone()
        .ok_or_else(|| AppError::Config("Operator session not initialized.".into()))?;
    let role = session.role.clone().unwrap_or_else(|| "operator".into());
    Ok(SessionSnapshot {
        user_id,
        user_name: session.user_name.clone(),
        role,
        operator_id,
        operator_name: session.operator_name.clone(),
        machine_id: session.machine_id.clone(),
        active_orders: session.active_orders.clone(),
    })
}

// -------------------------------------------------------------------------------------------------
// Global app state stored in Tauri
// -------------------------------------------------------------------------------------------------

pub(crate) struct AppState {
    config: RwLock<AppConfig>,
    app_pool: Mutex<Option<Pool>>,
    crimp_pool: Mutex<Option<Pool>>,
    session: Mutex<SessionState>,
    http_client: Client,
}

impl AppState {
    fn new() -> Result<Self, AppError> {
        let client = Client::builder()
            .timeout(Duration::from_secs(6))
            .build()
            .map_err(|err| AppError::Network(format!("http client: {err}")))?;
        let config = AppConfig::load();
        ensure_shared_directories(&config)?;
        Ok(Self {
            config: RwLock::new(config),
            app_pool: Mutex::new(None),
            crimp_pool: Mutex::new(None),
            session: Mutex::new(SessionState::default()),
            http_client: client,
        })
    }

    fn reload_config(&self) {
        let new_cfg = AppConfig::load();
        if let Err(err) = ensure_shared_directories(&new_cfg) {
            logging::log_error(&format!("Failed to refresh shared directories: {err}"));
        }
        {
            let mut cfg_guard = self.config.write().expect("config lock poisoned");
            *cfg_guard = new_cfg;
        }
        {
            let mut pool_guard = self.app_pool.lock().expect("app_pool lock poisoned");
            *pool_guard = None;
        }
        {
            let mut pool_guard = self.crimp_pool.lock().expect("crimp_pool lock poisoned");
            *pool_guard = None;
        }
    }

    pub(crate) fn app_pool(&self) -> Result<Pool, AppError> {
        {
            let guard = self.app_pool.lock().expect("app_pool lock poisoned");
            if let Some(pool) = &*guard {
                return Ok(pool.clone());
            }
        }
        let cfg = {
            let cfg_guard = self.config.read().expect("config lock poisoned");
            cfg_guard.app_db.clone()
        };
        let cfg = cfg.ok_or_else(|| AppError::Config("APP_DB_* variables missing".into()))?;
        let pool = cfg.create_pool()?;
        let mut guard = self.app_pool.lock().expect("app_pool lock poisoned");
        *guard = Some(pool.clone());
        Ok(pool)
    }

    fn crimp_pool(&self) -> Result<Pool, AppError> {
        {
            let guard = self.crimp_pool.lock().expect("crimp_pool lock poisoned");
            if let Some(pool) = &*guard {
                return Ok(pool.clone());
            }
        }
        let cfg = {
            let cfg_guard = self.config.read().expect("config lock poisoned");
            cfg_guard.crimp_db.clone()
        };
        let cfg = match cfg {
            Some(cfg) => cfg,
            None => return Err(AppError::Config("CRIMP_DB_* variables missing".into())),
        };
        let pool = cfg.create_pool()?;
        let mut guard = self.crimp_pool.lock().expect("crimp_pool lock poisoned");
        *guard = Some(pool.clone());
        Ok(pool)
    }

    #[cfg(test)]
    pub(crate) fn test_seed_session(
        &self,
        user_id: &str,
        operator_id: &str,
        machine_id: Option<&str>,
    ) {
        let mut session = self.session.lock().expect("session lock poisoned");
        session.user_id = Some(user_id.to_string());
        session.user_name = Some(user_id.to_string());
        session.role = Some("operator".into());
        session.operator_id = Some(operator_id.to_string());
        session.operator_name = Some(operator_id.to_string());
        session.machine_id = machine_id.map(|value| value.to_string());
    }
}

impl Drop for AppState {
    fn drop(&mut self) {
        cleanup_active_session(self);
    }
}

// -------------------------------------------------------------------------------------------------
// Crimp DB helpers
// -------------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct CrimpColumns {
    ref_col: String,
    joint_col: String,
    status_col: String,
    hc_col: String,
    traction_col: String,
}

static PM_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\s*([-+]?\d+(?:[.,]\d+)?)\s*±\s*([-+]?\d+(?:[.,]\d+)?)\s*$").unwrap()
});
static RANGE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\s*([-+]?\d+(?:[.,]\d+)?)\s*[-–—]\s*([-+]?\d+(?:[.,]\d+)?)\s*$").unwrap()
});
static TO_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\s*([-+]?\d+(?:[.,]\d+)?)\s*(?:to|à)\s*([-+]?\d+(?:[.,]\d+)?)\s*$").unwrap()
});
static ENTRE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"entre\s+([-+]?\d+(?:[.,]\d+)?)\s+(?:et|-|à)\s+([-+]?\d+(?:[.,]\d+)?)").unwrap()
});
static NUM_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"([-+]?\d+(?:[.,]\d+)?)").unwrap());

fn list_crimp_columns(conn: &mut PooledConn, table: &str) -> Result<HashSet<String>, AppError> {
    let query = format!("SHOW COLUMNS FROM `{table}`");
    let columns: Vec<String> = conn
        .query_map(query, |row: Row| {
            row.get::<String, _>("Field").unwrap_or_default()
        })
        .map_err(AppError::from)?;
    Ok(columns.into_iter().collect())
}

fn pick_column(present: &HashSet<String>, candidates: &[&str]) -> String {
    for candidate in candidates {
        if present.contains(*candidate) {
            return candidate.to_string();
        }
    }
    candidates.last().unwrap_or(&"").to_string()
}

fn resolve_crimp_columns(conn: &mut PooledConn, table: &str) -> Result<CrimpColumns, AppError> {
    let present = list_crimp_columns(conn, table)?;
    Ok(CrimpColumns {
        ref_col: pick_column(&present, &["APPLICATEUR", "REF ", "REF"]),
        joint_col: pick_column(&present, &["REF-JOINT ", "REF-JOINT"]),
        status_col: pick_column(&present, &["STATUT"]),
        hc_col: pick_column(&present, &["HC"]),
        traction_col: pick_column(
            &present,
            &[
                "Valeur de traction nominale ",
                "Valeur de traction nominale",
            ],
        ),
    })
}

fn parse_float(value: Option<String>) -> Option<f64> {
    let text = value?.trim().to_string();
    if text.is_empty() {
        return None;
    }
    let normalized = text.replace(',', ".");
    normalized.parse::<f64>().ok()
}

fn parse_bounds(raw: Option<String>) -> (Option<f64>, Option<f64>, Option<f64>) {
    let text = match raw {
        Some(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return (None, None, None);
            }
            trimmed.to_string()
        }
        None => return (None, None, None),
    };
    if let Some(caps) = PM_RE.captures(&text) {
        let nominal = parse_float(Some(caps[1].to_string()));
        let tolerance = parse_float(Some(caps[2].to_string()));
        if let (Some(n), Some(t)) = (nominal, tolerance) {
            return (Some(n - t), Some(n + t), Some(n));
        }
        return (nominal, None, nominal);
    }
    for regex in [&RANGE_RE, &TO_RE, &ENTRE_RE] {
        if let Some(caps) = regex.captures(&text) {
            let min = parse_float(Some(caps[1].to_string()));
            let max = parse_float(Some(caps[2].to_string()));
            if let (Some(min), Some(max)) = (min, max) {
                return (Some(min), Some(max), Some((min + max) / 2.0));
            }
        }
    }
    let mut numbers = NUM_RE
        .captures_iter(&text)
        .filter_map(|caps| parse_float(Some(caps[1].to_string())));
    match (numbers.next(), numbers.next()) {
        (Some(first), Some(second)) => (
            Some(first.min(second)),
            Some(first.max(second)),
            Some((first + second) / 2.0),
        ),
        (Some(value), None) => (Some(value), Some(value), Some(value)),
        _ => (None, None, None),
    }
}

fn normalize_status(raw: Option<String>) -> (Option<String>, bool) {
    let trimmed = raw
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let upper = trimmed.as_ref().map(|s| s.trim().to_ascii_uppercase());
    let ok = matches!(
        upper.as_deref(),
        Some("VALIDER") | Some("VALID") | Some("OK")
    );
    let normalized = match upper.as_deref() {
        Some("VALIDER") | Some("VALID") | Some("OK") => Some("VALID".to_string()),
        Some("NON VALIDER") | Some("NON VALIDE") | Some("INVALID") => Some("INVALID".to_string()),
        Some(value) if value.contains("MANQUE") || value.contains("PENDING") => {
            Some("PENDING".to_string())
        }
        Some(value) => Some(value.to_string()),
        None => None,
    };
    (normalized.or(trimmed), ok)
}

fn trim_opt(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn row_to_crimp_spec(row: Row) -> CrimpToolSpecResponse {
    let terminal_ref = trim_opt(row.get::<Option<String>, _>("terminal_ref").unwrap_or(None));
    let joint_ref = trim_opt(row.get::<Option<String>, _>("joint_ref").unwrap_or(None));
    let status_raw = row.get::<Option<String>, _>("status_raw").unwrap_or(None);
    let (status_normalized, status_ok) = normalize_status(status_raw);
    let (hc_min, hc_max, hc_nominal) =
        parse_bounds(row.get::<Option<String>, _>("hc_raw").unwrap_or(None));
    let traction_nominal =
        parse_float(row.get::<Option<String>, _>("traction_raw").unwrap_or(None));

    CrimpToolSpecResponse {
        status: status_normalized,
        status_ok,
        terminal_ref,
        joint_ref,
        hc_min,
        hc_max,
        hc_nominal,
        traction_nominal,
    }
}
// -------------------------------------------------------------------------------------------------
// Shared status helpers
// -------------------------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckStatus {
    ok: bool,
    message: String,
}

impl CheckStatus {
    fn ok(message: impl Into<String>) -> Self {
        Self {
            ok: true,
            message: message.into(),
        }
    }

    fn error(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            message: message.into(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreflightReport {
    app_db: CheckStatus,
    crimp_db: CheckStatus,
    shared_folder: CheckStatus,
    microscope_folder: CheckStatus,
    api: CheckStatus,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CrimpToolSpecResponse {
    status: Option<String>,
    status_ok: bool,
    terminal_ref: Option<String>,
    joint_ref: Option<String>,
    hc_min: Option<f64>,
    hc_max: Option<f64>,
    hc_nominal: Option<f64>,
    traction_nominal: Option<f64>,
}
// -------------------------------------------------------------------------------------------------
// Utility functions
// -------------------------------------------------------------------------------------------------

fn resolve_api_base_url(config: &AppConfig, role: &str) -> Option<String> {
    let base = config.api_base_url.clone()?;
    if role.trim().eq_ignore_ascii_case("admin") {
        return Some(base);
    }
    if let Some(admin_base) = config.admin_api_base_url.clone() {
        return Some(admin_base);
    }
    if let Some(master) = config.master_host.as_ref() {
        if let Ok(mut url) = Url::parse(&base) {
            if url.set_host(Some(master)).is_ok() {
                return Some(url.to_string());
            }
        }
    }
    Some(base)
}

fn parse_mysql_datetime(raw: &str) -> Option<NaiveDateTime> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    const FORMATS: [&str; 2] = ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%d %H:%M:%S"];
    for format in FORMATS {
        if let Ok(dt) = NaiveDateTime::parse_from_str(trimmed, format) {
            return Some(dt);
        }
    }
    None
}

fn locate_user_list_csv(path: &Path) -> Result<PathBuf, AppError> {
    let metadata = fs::metadata(path).map_err(|err| {
        AppError::Config(format!(
            "User list path not accessible at {} ({err})",
            path.display()
        ))
    })?;
    if metadata.is_file() {
        return Ok(path.to_path_buf());
    }
    if metadata.is_dir() {
        let preferred = [
            "userlist.csv",
            "user_list.csv",
            "users.csv",
            "operators.csv",
        ];
        for candidate in preferred {
            let candidate_path = path.join(candidate);
            if candidate_path.is_file() {
                return Ok(candidate_path);
            }
        }
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let entry_path = entry.path();
            if entry_path.is_file()
                && entry_path
                    .extension()
                    .map(|ext| ext.eq_ignore_ascii_case("csv"))
                    .unwrap_or(false)
            {
                return Ok(entry_path);
            }
        }
        return Err(AppError::Config(format!(
            "No CSV file found in user list directory {}",
            path.display()
        )));
    }
    Err(AppError::Config(format!(
        "USER_LIST_DIR is neither a file nor a directory: {}",
        path.display()
    )))
}

fn sync_file_if_newer(source: &Path, dest: &Path) -> Result<(), AppError> {
    if source == dest {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    let src_meta = fs::metadata(source)?;
    let should_copy = match fs::metadata(dest) {
        Ok(dst_meta) => {
            let src_mtime = src_meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let dst_mtime = dst_meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            src_mtime > dst_mtime
        }
        Err(_) => true,
    };
    if should_copy {
        fs::copy(source, dest)?;
    }
    Ok(())
}

fn load_file_from_candidate<F>(
    state: &AppState,
    candidate: &str,
    dest: &Path,
    resolve_dir: F,
) -> Result<bool, AppError>
where
    F: Fn(&Path) -> Result<PathBuf, AppError>,
{
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }

    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        match state
            .http_client
            .get(trimmed)
            .timeout(Duration::from_secs(4))
            .send()
        {
            Ok(resp) if resp.status().is_success() => {
                let bytes = resp
                    .bytes()
                    .map_err(|err| AppError::Network(err.to_string()))?;
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent)?;
                }
                let mut file = File::create(dest)?;
                file.write_all(&bytes)?;
                return Ok(true);
            }
            Ok(_) => return Ok(false),
            Err(err) => return Err(AppError::Network(err.to_string())),
        }
    }

    let path = if trimmed.starts_with("file://") {
        match Url::parse(trimmed) {
            Ok(url) => match url.to_file_path() {
                Ok(path) => path,
                Err(_) => return Ok(false),
            },
            Err(_) => return Ok(false),
        }
    } else {
        PathBuf::from(trimmed)
    };

    if !path.exists() {
        return Ok(false);
    }

    let source = if path.is_dir() {
        match resolve_dir(&path) {
            Ok(found) => found,
            Err(_) => return Ok(false),
        }
    } else {
        path
    };

    sync_file_if_newer(&source, dest)?;
    Ok(true)
}

fn ensure_user_list(state: &AppState, role: &str) -> Result<(PathBuf, bool), AppError> {
    let role = role.trim().to_ascii_lowercase();
    let config_snapshot = state.config.read().expect("config lock poisoned").clone();
    let user_list_path = config_snapshot
        .user_list_path
        .clone()
        .ok_or_else(|| AppError::Config("USER_LIST_DIR is not configured".into()))?;

    let mut base_name: OsString = user_list_path
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_else(|| OsString::from("userlist.csv"));

    let mut local_error: Option<AppError> = None;
    let local_csv = match locate_user_list_csv(&user_list_path) {
        Ok(path) => {
            if let Some(name) = path.file_name() {
                base_name = name.to_os_string();
            }
            Some(path)
        }
        Err(err) => {
            local_error = Some(err);
            None
        }
    };

    if role == "admin" {
        if let Some(csv_path) = local_csv.clone() {
            return Ok((csv_path, false));
        }
        if let Some(err) = local_error {
            return Err(err);
        }
        return Err(AppError::Config(
            "User list CSV is not accessible for admin login.".into(),
        ));
    }

    let shared_folder = config_snapshot.shared_folder.clone().ok_or_else(|| {
        AppError::Config("SHARED_FOLDER (or NETWORK_PHOTO_SHARE) not configured".into())
    })?;
    drop(config_snapshot);

    fs::create_dir_all(&shared_folder)?;
    let shared_csv = shared_folder.join(&base_name);

    let mut shared_ready = false;

    if let Some(csv_path) = local_csv.as_ref() {
        sync_file_if_newer(csv_path, &shared_csv)?;
        shared_ready = shared_csv.exists();
    }

    if !shared_ready {
        let cfg = state.config.read().expect("config lock poisoned").clone();
        let mut candidates: Vec<String> = Vec::new();
        if let Some(url) = cfg.userlist_url.clone() {
            candidates.push(url);
        }
        if let Some(url) = cfg.admin_userlist_url.clone() {
            candidates.push(url);
        }
        if candidates.is_empty() {
            if let Some(master) = cfg.master_host.as_ref() {
                let base_name_str = shared_csv
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("userlist.csv");
                for port in ["", ":8000", ":8080", ":5000"] {
                    let base = format!("http://{master}{port}");
                    candidates.push(format!("{base}/userlist.csv"));
                    candidates.push(format!("{base}/shared/userlist.csv"));
                    candidates.push(format!("{base}/{base_name_str}"));
                }
            }
        }

        let mut download_error: Option<AppError> = None;
        for candidate in candidates {
            match load_file_from_candidate(state, &candidate, &shared_csv, locate_user_list_csv) {
                Ok(true) => {
                    shared_ready = true;
                    break;
                }
                Ok(false) => continue,
                Err(err) => download_error = Some(err),
            }
        }

        if !shared_ready {
            if let Some(err) = download_error {
                return Err(err);
            }
            if let Some(err) = local_error {
                return Err(err);
            }
            return Err(AppError::Network(format!(
                "Unable to obtain user list for role '{role}'"
            )));
        }
    }

    let mut env_loaded = false;
    let cfg = state.config.read().expect("config lock poisoned").clone();
    let admin_env_path = shared_folder.join("admin.env");
    let alt_env_path = shared_folder.join(".env");

    if !admin_env_path.exists() && !alt_env_path.exists() {
        let mut candidates: Vec<String> = Vec::new();
        if let Some(url) = cfg.admin_env_url.clone() {
            candidates.push(url);
        }
        if candidates.is_empty() {
            if let Some(master) = cfg.master_host.as_ref() {
                for port in ["", ":8000", ":8080", ":5000"] {
                    let base = format!("http://{master}{port}");
                    candidates.push(format!("{base}/admin.env"));
                    candidates.push(format!("{base}/shared/admin.env"));
                    candidates.push(format!("{base}/.env"));
                }
            }
        }

        let env_file_name = admin_env_path
            .file_name()
            .map(|name| name.to_os_string())
            .unwrap_or_else(|| OsString::from("admin.env"));

        for candidate in candidates {
            let env_file_name = env_file_name.clone();
            match load_file_from_candidate(state, &candidate, &admin_env_path, move |dir: &Path| {
                let primary = dir.join(&env_file_name);
                if primary.is_file() {
                    return Ok(primary);
                }
                let alt = dir.join(".env");
                if alt.is_file() {
                    return Ok(alt);
                }
                Err(AppError::Config(format!(
                    "No env file found in {}",
                    dir.display()
                )))
            }) {
                Ok(true) => {
                    env_loaded = true;
                    break;
                }
                Ok(false) => continue,
                Err(_) => continue,
            }
        }
    } else {
        env_loaded = true;
    }

    if admin_env_path.exists() {
        let _ = dotenvy::from_path(&admin_env_path);
    } else if alt_env_path.exists() {
        let _ = dotenvy::from_path(&alt_env_path);
    } else {
        env_loaded = false;
    }

    Ok((shared_csv, env_loaded))
}

fn match_user_in_csv(
    csv_path: &Path,
    user_id: &str,
    user_name: &str,
) -> Result<Option<(String, Option<String>)>, AppError> {
    let mut reader = csv::Reader::from_path(csv_path)?;
    let headers = reader
        .headers()?
        .iter()
        .map(|h| h.to_string())
        .collect::<Vec<_>>();
    if headers.is_empty() {
        return Ok(None);
    }

    let mut id_idx: Option<usize> = None;
    let mut name_idx: Option<usize> = None;
    let mut post_idx: Option<usize> = None;
    for (idx, header) in headers.iter().enumerate() {
        let h = header.trim().to_ascii_lowercase();
        if id_idx.is_none() && matches!(h.as_str(), "user_id" | "id" | "userid" | "user-id") {
            id_idx = Some(idx);
        }
        if name_idx.is_none()
            && matches!(h.as_str(), "user_name" | "username" | "name" | "user-name")
        {
            name_idx = Some(idx);
        }
        if post_idx.is_none()
            && matches!(
                h.as_str(),
                "user_post" | "post" | "role" | "user-role" | "user_role"
            )
        {
            post_idx = Some(idx);
        }
    }
    if id_idx.is_none() || name_idx.is_none() {
        if headers.len() >= 2 {
            id_idx = Some(0);
            name_idx = Some(1);
        }
    }

    let Some(id_idx) = id_idx else {
        return Ok(None);
    };
    let Some(name_idx) = name_idx else {
        return Ok(None);
    };

    let user_id_lc = user_id.trim().to_ascii_lowercase();
    let user_name_lc = user_name.trim().to_ascii_lowercase();

    for record in reader.records() {
        let record = record?;
        let id_val = record.get(id_idx).unwrap_or("").trim().to_ascii_lowercase();
        let name_val = record
            .get(name_idx)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if id_val == user_id_lc && name_val == user_name_lc {
            let display_name = record.get(name_idx).unwrap_or("").trim().to_string();
            let csv_role = post_idx
                .and_then(|idx| record.get(idx))
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            return Ok(Some((display_name, csv_role)));
        }
    }
    Ok(None)
}

fn find_operator_name(
    csv_path: &Path,
    operator_id: &str,
) -> Result<Option<(String, Option<String>)>, AppError> {
    let mut reader = csv::Reader::from_path(csv_path)?;
    let headers = reader
        .headers()?
        .iter()
        .map(|h| h.to_string())
        .collect::<Vec<_>>();
    if headers.is_empty() {
        return Ok(None);
    }
    let mut id_idx: Option<usize> = None;
    let mut name_idx: Option<usize> = None;
    let mut post_idx: Option<usize> = None;
    for (idx, header) in headers.iter().enumerate() {
        let h = header.trim().to_ascii_lowercase();
        if id_idx.is_none()
            && matches!(
                h.as_str(),
                "operator_id" | "operator" | "user_id" | "id" | "userid" | "user-id"
            )
        {
            id_idx = Some(idx);
        }
        if name_idx.is_none()
            && matches!(
                h.as_str(),
                "operator_name" | "name" | "user_name" | "username" | "user-name"
            )
        {
            name_idx = Some(idx);
        }
        if post_idx.is_none()
            && matches!(
                h.as_str(),
                "user_post" | "post" | "role" | "user-role" | "user_role"
            )
        {
            post_idx = Some(idx);
        }
    }
    if id_idx.is_none() {
        id_idx = Some(0);
    }
    if name_idx.is_none() {
        name_idx = Some(id_idx.unwrap_or(0));
    }
    let Some(id_idx) = id_idx else {
        return Ok(None);
    };
    let Some(name_idx) = name_idx else {
        return Ok(None);
    };
    let operator_id_lc = operator_id.trim().to_ascii_lowercase();

    for record in reader.records() {
        let record = record?;
        let id_val = record.get(id_idx).unwrap_or("").trim().to_ascii_lowercase();
        if id_val == operator_id_lc {
            let operator_name = record.get(name_idx).unwrap_or("").trim().to_string();
            let csv_role = post_idx
                .and_then(|idx| record.get(idx))
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            return Ok(Some((operator_name, csv_role)));
        }
    }
    Ok(None)
}

fn verify_user_id_only(
    csv_path: &Path,
    user_id: &str,
) -> Result<Option<(String, bool)>, AppError> {
    let mut reader = csv::Reader::from_path(csv_path)?;
    let headers = reader
        .headers()?
        .iter()
        .map(|h| h.to_string())
        .collect::<Vec<_>>();
    if headers.is_empty() {
        return Ok(None);
    }

    let mut id_idx: Option<usize> = None;
    let mut name_idx: Option<usize> = None;
    let mut post_idx: Option<usize> = None;
    for (idx, header) in headers.iter().enumerate() {
        let h = header.trim().to_ascii_lowercase();
        if id_idx.is_none() && matches!(h.as_str(), "user_id" | "id" | "userid" | "user-id") {
            id_idx = Some(idx);
        }
        if name_idx.is_none()
            && matches!(h.as_str(), "user_name" | "username" | "name" | "user-name")
        {
            name_idx = Some(idx);
        }
        if post_idx.is_none()
            && matches!(
                h.as_str(),
                "user_post" | "post" | "role" | "user-role" | "user_role"
            )
        {
            post_idx = Some(idx);
        }
    }
    if id_idx.is_none() {
        id_idx = Some(0);
    }
    if name_idx.is_none() {
        name_idx = Some(id_idx.unwrap_or(0));
    }
    let Some(id_idx) = id_idx else {
        return Ok(None);
    };
    let Some(name_idx) = name_idx else {
        return Ok(None);
    };
    let user_id_lc = user_id.trim().to_ascii_lowercase();

    for record in reader.records() {
        let record = record?;
        let id_val = record.get(id_idx).unwrap_or("").trim().to_ascii_lowercase();
        if id_val == user_id_lc {
            let user_name = record.get(name_idx).unwrap_or("").trim().to_string();
            let csv_role = post_idx
                .and_then(|idx| record.get(idx))
                .map(|s| s.trim().to_ascii_lowercase())
                .unwrap_or_default();
            // Check if admin based on role column
            let is_admin = csv_role.contains("admin") || csv_role.contains("administrator");
            return Ok(Some((user_name, is_admin)));
        }
    }
    Ok(None)
}

const CREATE_USER_SESSIONS_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS user_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  app_user_id VARCHAR(64) NOT NULL,
  operator_id VARCHAR(64) NOT NULL,
  host VARCHAR(128) NULL,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  heartbeat_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_user_operator (app_user_id, operator_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"#;

const CREATE_WORK_ORDERS_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS work_orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  app_user_id VARCHAR(64) NOT NULL,
  operator_id VARCHAR(64) NOT NULL,
  machine_id VARCHAR(64) NULL,
  of_id VARCHAR(64) NOT NULL,
  reference VARCHAR(128) NOT NULL,
  quantity_total INT NOT NULL,
  bundle_count INT NOT NULL,
  status ENUM('pending','in_progress','completed') DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_order_user (app_user_id, operator_id, of_id),
  UNIQUE KEY uk_order_unique (of_id, reference)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"#;

const CREATE_ORDER_WIRES_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS order_wires (
  id INT AUTO_INCREMENT PRIMARY KEY,
  work_order_id INT NOT NULL,
  ref_coil VARCHAR(64) NOT NULL,
  ref_wire VARCHAR(64) NOT NULL,
  marquage TEXT NOT NULL,
  length_mm INT DEFAULT 0,
  section DOUBLE DEFAULT NULL,
  color_primary VARCHAR(64) DEFAULT NULL,
  color_secondary VARCHAR(64) DEFAULT NULL,
  ext1 TEXT DEFAULT NULL,
  ext2 TEXT DEFAULT NULL,
  target_quantity INT NOT NULL,
  bundle_count INT NOT NULL,
  operator_test_done BOOLEAN NOT NULL DEFAULT FALSE,
  produced_quantity INT NOT NULL DEFAULT 0,
  status ENUM('not_validated','validated','in_production','qc_boot','qc_wheel','qc_final','paused','stopped','completed') DEFAULT 'not_validated',
  previous_status ENUM('not_validated','validated','in_production','qc_boot','qc_wheel','qc_final','paused','stopped','completed') DEFAULT NULL,
  boot_test_done BOOLEAN NOT NULL DEFAULT FALSE,
  boot_test_required BOOLEAN NOT NULL DEFAULT TRUE,
  boot_test_required_count INT NOT NULL DEFAULT 1,
  boot_test_done_count INT NOT NULL DEFAULT 0,
  wheel_test_done BOOLEAN NOT NULL DEFAULT FALSE,
  wheel_test_required BOOLEAN NOT NULL DEFAULT FALSE,
  final_test_done BOOLEAN NOT NULL DEFAULT FALSE,
  final_test_required BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_order_wire (work_order_id, ref_wire, marquage(255)),
  CONSTRAINT fk_order FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"#;

const CREATE_OPERATOR_CONTROL_LOGS_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS operator_control_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  of_id VARCHAR(64),
  ref VARCHAR(64),
  ref_coil VARCHAR(64),
  machine_id VARCHAR(64),
  operator_id VARCHAR(64),
  control_crimping_height_left DECIMAL(10,3) NULL,
  control_crimping_height_right DECIMAL(10,3) NULL,
  control_traction_force_left DECIMAL(10,3) NULL,
  control_traction_force_right DECIMAL(10,3) NULL,
  control_stripping_left DECIMAL(10,3) NULL,
  control_stripping_right DECIMAL(10,3) NULL,
  control_length DECIMAL(10,3) NULL,
  path_image_left VARCHAR(255) NULL,
  path_image_right VARCHAR(255) NULL,
  status ENUM('OK','NOK') DEFAULT 'OK',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"#;

const CREATE_QUALITY_EVENTS_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS quality_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  event VARCHAR(64) NOT NULL,
  of_id VARCHAR(64),
  ref VARCHAR(64),
  ref_coil VARCHAR(64),
  side ENUM('left','right') NULL,
  operator_id VARCHAR(64),
  machine_id VARCHAR(64),
  note TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"#;

const CREATE_LOGS_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ref_of VARCHAR(64) NULL,
  ref_product VARCHAR(64) NULL,
  quantity DECIMAL(10,3) NULL,
  status ENUM('START','PAUSE','STOP','END','LABEL','CONTROL_OP','CONTROL_QUALITY','CHANGE_COIL',
              'CHANGE_USER','CALL_MAINTENANCE','CALL_QUALITY','CALL_PRODUCTION','CALL_UNCONFORMITY','MAINTENANCE','RESTART','RESUME') NOT NULL,
  note TEXT NULL,
  engine_name VARCHAR(64) NULL,
  user_number VARCHAR(64) NULL,
  app_user_id VARCHAR(64) NULL,
  app_user_name VARCHAR(128) NULL,
  op_quality_number VARCHAR(64) NULL,
  op_maintenance_number VARCHAR(64) NULL,
  ref_wire VARCHAR(64) NULL,
  ref_coil VARCHAR(64) NULL,
  ref_tool_1 VARCHAR(64) NULL,
  ref_tool_2 VARCHAR(64) NULL,
  label_id VARCHAR(128) NULL,
  bac_id VARCHAR(64) NULL,
  control_length DECIMAL(10,3) NULL,
  control_stripping_left DECIMAL(10,3) NULL,
  control_stripping_right DECIMAL(10,3) NULL,
  control_crimping_height_left DECIMAL(10,3) NULL,
  control_crimping_height_right DECIMAL(10,3) NULL,
  control_traction_force_left DECIMAL(10,3) NULL,
  control_traction_force_right DECIMAL(10,3) NULL,
  path_image VARCHAR(255) NULL,
  path_image_left VARCHAR(255) NULL,
  path_image_right VARCHAR(255) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"#;

fn ensure_user_session_tables(conn: &mut PooledConn) -> Result<(), AppError> {
    conn.query_drop(CREATE_USER_SESSIONS_SQL)?;
    Ok(())
}

fn ensure_workflow_tables(conn: &mut PooledConn) -> Result<(), AppError> {
    conn.query_drop(CREATE_WORK_ORDERS_SQL)?;
    conn.query_drop(CREATE_ORDER_WIRES_SQL)?;
    let unique_exists: Option<i64> = conn.exec_first(
        "SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'work_orders' AND index_name = 'uk_order_unique'",
        (),
    )?;
    if unique_exists.unwrap_or(0) == 0 {
        match conn
            .query_drop("ALTER TABLE work_orders ADD UNIQUE KEY uk_order_unique (of_id, reference)")
        {
            Ok(_) => {}
            Err(MysqlError::MySqlError(ref mysql_err)) if mysql_err.code == 1062 => {
                return Err(AppError::Config(
                    "Duplicate work orders detected for the same OF and reference. Clean up duplicates before continuing."
                        .into(),
                ));
            }
            Err(err) => return Err(AppError::from(err)),
        }
    }
    // Ensure new columns exist for boot test counting (compatible with older MySQL)
    let exists_required: Option<i64> = conn.exec_first(
        "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'order_wires' AND column_name = 'boot_test_required_count'",
        (),
    )?;
    if exists_required.unwrap_or(0) == 0 {
        conn.query_drop(
            "ALTER TABLE order_wires ADD COLUMN boot_test_required_count INT NOT NULL DEFAULT 1",
        )?;
    }
    let exists_done: Option<i64> = conn.exec_first(
        "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'order_wires' AND column_name = 'boot_test_done_count'",
        (),
    )?;
    if exists_done.unwrap_or(0) == 0 {
        conn.query_drop(
            "ALTER TABLE order_wires ADD COLUMN boot_test_done_count INT NOT NULL DEFAULT 0",
        )?;
    }
    let exists_previous_status: Option<i64> = conn.exec_first(
        "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'order_wires' AND column_name = 'previous_status'",
        (),
    )?;
    if exists_previous_status.unwrap_or(0) == 0 {
        conn.query_drop(
            "ALTER TABLE order_wires ADD COLUMN previous_status ENUM('not_validated','validated','in_production','qc_boot','qc_wheel','qc_final','paused','stopped','completed','pending','in_progress','blocked_wheel','blocked_final') DEFAULT NULL",
        )?;
    } else {
        // Ensure legacy columns are updated
        conn.query_drop(
            "ALTER TABLE order_wires MODIFY COLUMN previous_status ENUM('not_validated','validated','in_production','qc_boot','qc_wheel','qc_final','paused','stopped','completed','pending','in_progress','blocked_wheel','blocked_final') DEFAULT NULL",
        )?;
    }
    let exists_operator_flag: Option<i64> = conn.exec_first(
        "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'order_wires' AND column_name = 'operator_test_done'",
        (),
    )?;
    if exists_operator_flag.unwrap_or(0) == 0 {
        conn.query_drop(
            "ALTER TABLE order_wires ADD COLUMN operator_test_done BOOLEAN NOT NULL DEFAULT FALSE",
        )?;
    }
    let exists_stopped_by: Option<i64> = conn.exec_first(
        "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'order_wires' AND column_name = 'stopped_by_user'",
        (),
    )?;
    if exists_stopped_by.unwrap_or(0) == 0 {
        conn.query_drop(
            "ALTER TABLE order_wires ADD COLUMN stopped_by_user VARCHAR(64) NULL",
        )?;
    }
    let status_column_type: Option<String> = conn.exec_first(
        "SELECT COLUMN_TYPE FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'order_wires' AND column_name = 'status'",
        (),
    )?;
    if let Some(column_type) = status_column_type {
        let has_legacy_status = column_type.contains("'pending'")
            || column_type.contains("'in_progress'")
            || column_type.contains("'blocked_wheel'")
            || column_type.contains("'blocked_final'");
        if !column_type.contains("'not_validated'") || has_legacy_status {
            conn.query_drop(
                "ALTER TABLE order_wires MODIFY COLUMN status ENUM('pending','validated','in_progress','blocked_wheel','blocked_final','paused','stopped','completed','not_validated','in_production','qc_boot','qc_wheel','qc_final') NOT NULL DEFAULT 'pending'",
            )?;
            conn.query_drop(
                "ALTER TABLE order_wires MODIFY COLUMN previous_status ENUM('pending','validated','in_progress','blocked_wheel','blocked_final','paused','stopped','completed','not_validated','in_production','qc_boot','qc_wheel','qc_final') DEFAULT NULL",
            )?;
            conn.exec_drop(
                "UPDATE order_wires SET status = CASE
                    WHEN status = 'pending' THEN 'not_validated'
                    WHEN status = 'in_progress' THEN 'in_production'
                    WHEN status = 'blocked_wheel' THEN 'qc_wheel'
                    WHEN status = 'blocked_final' THEN 'qc_final'
                    ELSE status
                 END",
                (),
            )?;
            conn.exec_drop(
                "UPDATE order_wires SET status = 'qc_boot' WHERE status = 'validated' AND boot_test_required = TRUE AND boot_test_done_count < boot_test_required_count",
                (),
            )?;
            conn.exec_drop(
                "UPDATE order_wires SET previous_status = CASE
                    WHEN previous_status = 'pending' THEN 'not_validated'
                    WHEN previous_status = 'in_progress' THEN 'in_production'
                    WHEN previous_status = 'blocked_wheel' THEN 'qc_wheel'
                    WHEN previous_status = 'blocked_final' THEN 'qc_final'
                    ELSE previous_status
                 END",
                (),
            )?;
            conn.query_drop(
                "ALTER TABLE order_wires MODIFY COLUMN status ENUM('not_validated','validated','in_production','qc_boot','qc_wheel','qc_final','paused','stopped','completed') NOT NULL DEFAULT 'not_validated'",
            )?;
            conn.query_drop(
                "ALTER TABLE order_wires MODIFY COLUMN previous_status ENUM('not_validated','validated','in_production','qc_boot','qc_wheel','qc_final','paused','stopped','completed') DEFAULT NULL",
            )?;
        }
    }
    Ok(())
}

pub(crate) fn ensure_logging_tables(conn: &mut PooledConn) -> Result<(), AppError> {
    conn.query_drop(CREATE_OPERATOR_CONTROL_LOGS_SQL)?;
    conn.query_drop(CREATE_QUALITY_EVENTS_SQL)?;
    conn.query_drop(CREATE_LOGS_SQL)?;
    ensure_operator_control_log_schema(conn)?;
    ensure_logs_image_schema(conn)?;
    Ok(())
}

fn column_exists(conn: &mut PooledConn, table: &str, column: &str) -> Result<bool, AppError> {
    let count: Option<i64> = conn.exec_first(
        "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
        (table, column),
    )?;
    Ok(count.unwrap_or(0) > 0)
}

fn ensure_operator_control_log_schema(conn: &mut PooledConn) -> Result<(), AppError> {
    if !column_exists(conn, "operator_control_logs", "path_image_left")? {
        if column_exists(conn, "operator_control_logs", "path_image_front")? {
            conn.query_drop(
                "ALTER TABLE operator_control_logs CHANGE COLUMN path_image_front path_image_left VARCHAR(255) NULL",
            )?;
        } else {
            conn.query_drop(
                "ALTER TABLE operator_control_logs ADD COLUMN path_image_left VARCHAR(255) NULL AFTER control_length",
            )?;
        }
    }
    if !column_exists(conn, "operator_control_logs", "path_image_right")? {
        if column_exists(conn, "operator_control_logs", "path_image_back")? {
            conn.query_drop(
                "ALTER TABLE operator_control_logs CHANGE COLUMN path_image_back path_image_right VARCHAR(255) NULL",
            )?;
        } else {
            conn.query_drop(
                "ALTER TABLE operator_control_logs ADD COLUMN path_image_right VARCHAR(255) NULL AFTER path_image_left",
            )?;
        }
    }
    Ok(())
}

fn ensure_logs_image_schema(conn: &mut PooledConn) -> Result<(), AppError> {
    if !column_exists(conn, "logs", "path_image_left")? {
        conn.query_drop(
            "ALTER TABLE logs ADD COLUMN path_image_left VARCHAR(255) NULL AFTER path_image",
        )?;
    }

    // Update status ENUM to include RESTART and RESUME
    conn.query_drop(
        "ALTER TABLE logs MODIFY COLUMN status ENUM('START','PAUSE','STOP','END','LABEL','CONTROL_OP','CONTROL_QUALITY','CHANGE_COIL','CHANGE_USER','CALL_MAINTENANCE','CALL_QUALITY','CALL_PRODUCTION','CALL_UNCONFORMITY','MAINTENANCE','RESTART','RESUME') NOT NULL",
    )?;

    if !column_exists(conn, "logs", "path_image_right")? {
        conn.query_drop(
            "ALTER TABLE logs ADD COLUMN path_image_right VARCHAR(255) NULL AFTER path_image_left",
        )?;
    }
    migrate_log_path_images(conn)?;
    Ok(())
}

fn migrate_log_path_images(conn: &mut PooledConn) -> Result<(), AppError> {
    let rows: Vec<Row> = conn.exec(
        "SELECT id, path_image, path_image_left, path_image_right FROM logs WHERE path_image IS NOT NULL AND path_image <> '' AND (path_image_left IS NULL AND path_image_right IS NULL)",
        (),
    )?;

    for mut row in rows {
        let id: u64 = row
            .take::<Option<u64>, _>("id")
            .unwrap_or(None)
            .unwrap_or(0);
        let legacy = row.take::<Option<String>, _>("path_image").unwrap_or(None);
        let left_existing = row
            .take::<Option<String>, _>("path_image_left")
            .unwrap_or(None);
        let right_existing = row
            .take::<Option<String>, _>("path_image_right")
            .unwrap_or(None);

        if legacy.is_none() || left_existing.is_some() || right_existing.is_some() {
            continue;
        }

        let legacy_value = legacy.unwrap();
        let (left, right) = split_legacy_path_image(&legacy_value);
        if left.is_none() && right.is_none() {
            continue;
        }

        let combined =
            combine_legacy_path_image(left.as_deref(), right.as_deref(), &format!("log #{id}"))
                .unwrap_or_else(|| {
                    let mut fallback = legacy_value.clone();
                    if fallback.len() > 255 {
                        fallback.truncate(255);
                    }
                    fallback
                });

        conn.exec_drop(
            "UPDATE logs SET path_image_left = :left, path_image_right = :right, path_image = :legacy WHERE id = :id",
            params! {
                "left" => left.as_deref(),
                "right" => right.as_deref(),
                "legacy" => combined.as_str(),
                "id" => id,
            },
        )?;
    }

    Ok(())
}

fn normalize_wire_status(value: &str) -> &str {
    match value {
        "pending" => "not_validated",
        "in_progress" => "in_production",
        "blocked_wheel" => "qc_wheel",
        "blocked_final" => "qc_final",
        other => other,
    }
}

fn is_user_operator_active(
    conn: &mut PooledConn,
    app_user_id: &str,
    operator_id: &str,
    host: &str,
) -> Result<bool, AppError> {
    let row: Option<(Option<String>,)> = conn.exec_first(
        "SELECT host FROM user_sessions WHERE app_user_id = ? AND operator_id = ?",
        (app_user_id, operator_id),
    )?;
    if let Some((stored_host_opt,)) = row {
        if let Some(stored_host) = stored_host_opt {
            let stored = stored_host.trim().to_ascii_lowercase();
            let current = host.trim().to_ascii_lowercase();
            if !stored.is_empty() && !current.is_empty() && stored == current {
                return Ok(false);
            }
        }
        return Ok(true);
    }
    Ok(false)
}

fn upsert_user_session(
    conn: &mut PooledConn,
    app_user_id: &str,
    operator_id: &str,
    host: &str,
) -> Result<(), AppError> {
    conn.exec_drop(
        "INSERT INTO user_sessions (app_user_id, operator_id, host) VALUES (?, ?, ?) \
         ON DUPLICATE KEY UPDATE host = VALUES(host), heartbeat_at = CURRENT_TIMESTAMP",
        (app_user_id, operator_id, host),
    )?;
    Ok(())
}

fn clear_user_session(
    conn: &mut PooledConn,
    app_user_id: &str,
    operator_id: &str,
) -> Result<(), AppError> {
    conn.exec_drop(
        "DELETE FROM user_sessions WHERE app_user_id = ? AND operator_id = ?",
        (app_user_id, operator_id),
    )?;
    Ok(())
}

fn clear_sessions_for_host(conn: &mut PooledConn, host: &str) -> Result<(), AppError> {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    conn.exec_drop("DELETE FROM user_sessions WHERE host = ?", (trimmed,))?;
    Ok(())
}

fn cleanup_active_session(state: &AppState) {
    let (user_id, operator_id) = {
        let session = state.session.lock().expect("session lock poisoned");
        (session.user_id.clone(), session.operator_id.clone())
    };
    if let (Some(uid), Some(op_id)) = (user_id, operator_id) {
        if let Ok(pool) = state.app_pool() {
            if let Ok(mut conn) = pool.get_conn() {
                if ensure_user_session_tables(&mut conn).is_ok() {
                    let _ = clear_user_session(&mut conn, &uid, &op_id);
                }
            }
        }
    }
}

fn build_product_url(config: &AppConfig, role: &str, reference: &str) -> Result<String, AppError> {
    let reference = reference.trim();
    if reference.is_empty() {
        return Err(AppError::Config("Order reference is missing.".into()));
    }
    let mut base = resolve_api_base_url(config, role)
        .ok_or_else(|| AppError::Config("API_BASE_URL not configured.".into()))?;
    if base.contains("{ref}") {
        base = base.replace("{ref}", reference);
        return Ok(base);
    }
    if !base.ends_with('/') {
        base.push('/');
    }
    base.push_str(reference);
    if !base.ends_with('/') {
        base.push('/');
    }
    base.push_str("alFilis");
    Ok(base)
}

fn fetch_product_wires(
    state: &AppState,
    reference: &str,
    role: &str,
) -> Result<Vec<ApiCoil>, AppError> {
    let config_snapshot = state.config.read().expect("config lock poisoned").clone();
    let url = build_product_url(&config_snapshot, role, reference)?;
    drop(config_snapshot);

    let response = state
        .http_client
        .get(url.clone())
        .timeout(Duration::from_secs(8))
        .send()
        .map_err(|err| AppError::Network(format!("API request failed for {url}: {err}")))?;
    if !response.status().is_success() {
        return Err(AppError::Network(format!(
            "API responded with status {} for {url}",
            response.status()
        )));
    }
    response
        .json::<Vec<ApiCoil>>()
        .map_err(|err| AppError::Network(format!("Invalid API payload for {url}: {err}")))
}

fn store_wires_for_order(
    conn: &mut PooledConn,
    work_order_id: u64,
    coils: &[ApiCoil],
    quantity_total: u32,
    bundle_count: u32,
) -> Result<(), AppError> {
    let target_quantity = i32::try_from(quantity_total).unwrap_or(i32::MAX);
    let bundles = if bundle_count == 0 {
        1
    } else {
        i32::try_from(bundle_count).unwrap_or(1)
    };

    // Determine required tests based on total quantity
    let (boot_required_count, wheel_required_anytime, final_required_anytime) =
        compute_quality_requirements_for_quantity(quantity_total as i32);

    for coil in coils {
        for wire in &coil.wires {
            let length_mm = wire.length.map(|value| value.round() as i32).unwrap_or(0);
            let ext1_json = wire
                .ext1
                .as_ref()
                .and_then(|ext| serde_json::to_string(ext).ok());
            let ext2_json = wire
                .ext2
                .as_ref()
                .and_then(|ext| serde_json::to_string(ext).ok());

            conn.exec_drop(
                "INSERT INTO order_wires (
                    work_order_id, ref_coil, ref_wire, marquage, length_mm, section, color_primary, color_secondary, ext1, ext2,
                    target_quantity, bundle_count, boot_test_required, boot_test_required_count, boot_test_done, boot_test_done_count, wheel_test_required, final_test_required
                 ) VALUES (
                    :work_order_id, :ref_coil, :ref_wire, :marquage, :length_mm, :section, :color_primary, :color_secondary, :ext1, :ext2,
                    :target_quantity, :bundle_count, :boot_required, :boot_required_count, FALSE, 0, :wheel_required, :final_required
                 ) ON DUPLICATE KEY UPDATE
                    length_mm = VALUES(length_mm), section = VALUES(section), color_primary = VALUES(color_primary), color_secondary = VALUES(color_secondary),
                    ext1 = VALUES(ext1), ext2 = VALUES(ext2), target_quantity = VALUES(target_quantity), bundle_count = VALUES(bundle_count),
                    boot_test_required = VALUES(boot_test_required), boot_test_required_count = VALUES(boot_test_required_count),
                    wheel_test_required = VALUES(wheel_test_required), final_test_required = VALUES(final_test_required), updated_at = CURRENT_TIMESTAMP",
                params!{
                    "work_order_id" => work_order_id,
                    "ref_coil" => coil.ref_coil.as_str(),
                    "ref_wire" => wire.ref_wire.as_str(),
                    "marquage" => wire.marquage.as_str(),
                    "length_mm" => length_mm,
                    "section" => coil.section,
                    "color_primary" => coil.color_primary.clone(),
                    "color_secondary" => coil.color_secondary.clone(),
                    "ext1" => ext1_json,
                    "ext2" => ext2_json,
                    "target_quantity" => target_quantity,
                    "bundle_count" => bundles,
                    "boot_required" => (boot_required_count > 0),
                    "boot_required_count" => boot_required_count,
                    "wheel_required" => wheel_required_anytime,
                    "final_required" => final_required_anytime,
                },
            )?;
        }
    }
    Ok(())
}

fn canonicalize_order_key(of_id: &str, reference: &str) -> String {
    format!(
        "{}::{}",
        of_id.trim().to_ascii_uppercase(),
        reference.trim().to_ascii_uppercase()
    )
}

fn work_order_has_activity(conn: &mut PooledConn, work_order_id: u64) -> Result<bool, AppError> {
    Ok(conn
        .exec_first::<u8, _, _>(
            "SELECT 1 FROM order_wires\n             WHERE work_order_id = ? AND (\
                produced_quantity > 0 OR \
                operator_test_done = TRUE OR \
                boot_test_done = TRUE OR \
                boot_test_done_count > 0 OR \
                wheel_test_done = TRUE OR \
                final_test_done = TRUE OR \
                status NOT IN ('not_validated','validated')\
             ) LIMIT 1",
            (work_order_id,),
        )?
        .is_some())
}

fn upsert_orders_and_wires(
    state: &AppState,
    conn: &mut PooledConn,
    app_user_id: &str,
    operator_id: &str,
    machine_id: Option<&str>,
    orders: &[WorkOrderInput],
    role: &str,
) -> Result<(), AppError> {
    ensure_workflow_tables(conn)?;

    if orders.is_empty() {
        return Ok(());
    }

    let machine_id_value = machine_id
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());

    for order in orders {
        let of_id = order.of_id.trim();
        let reference = order.reference.trim();
        if of_id.is_empty() || reference.is_empty() {
            return Err(AppError::Config(
                "Each work order must include an OF identifier and product reference.".into(),
            ));
        }

        let quantity_total = i32::try_from(order.quantity_total).unwrap_or(i32::MAX);
        let bundle_count = if order.bundle_count == 0 {
            1
        } else {
            i32::try_from(order.bundle_count).unwrap_or(1)
        };

        let existing_row = conn.exec_first::<Row, _, _>(
            "SELECT id, operator_id, status, quantity_total, bundle_count FROM work_orders WHERE of_id = ? AND reference = ?",
            (of_id, reference),
        )?;

        match existing_row {
            Some(mut row) => {
                let work_order_id: u64 = row.take("id").unwrap_or_default();
                let owner_operator_raw: String = row
                    .take::<Option<String>, _>("operator_id")
                    .unwrap_or(None)
                    .unwrap_or_default();
                let existing_status: String = row
                    .take::<Option<String>, _>("status")
                    .unwrap_or(None)
                    .unwrap_or_else(|| "pending".into());
                let existing_quantity: i32 = row
                    .take::<Option<i64>, _>("quantity_total")
                    .unwrap_or(None)
                    .unwrap_or(0) as i32;
                let existing_bundles: i32 = row
                    .take::<Option<i64>, _>("bundle_count")
                    .unwrap_or(None)
                    .unwrap_or(0) as i32;

                let owner_operator_trimmed = owner_operator_raw.trim();
                let normalized_owner = owner_operator_trimmed.to_ascii_uppercase();
                let normalized_requester = operator_id.trim().to_ascii_uppercase();

                if existing_status == "completed" {
                    if normalized_owner.is_empty() {
                        return Err(AppError::Config(format!(
                            "Order {of_id} / {reference} is already completed and cannot be restarted."
                        )));
                    } else {
                        return Err(AppError::Config(format!(
                            "Order {of_id} / {reference} is already completed by Operator {} and cannot be restarted.",
                            normalized_owner
                        )));
                    }
                }

                if !normalized_owner.is_empty() && normalized_owner != normalized_requester {
                    return Err(AppError::Config(format!(
                        "Order {of_id} / {reference} already started by Operator {}. Only Operator {} can continue.",
                        normalized_owner, normalized_owner
                    )));
                }

                let dimensions_mismatch =
                    existing_quantity != quantity_total || existing_bundles != bundle_count;
                if dimensions_mismatch && work_order_has_activity(conn, work_order_id)? {
                    return Err(AppError::Config(format!(
                        "Order {of_id} / {reference} already has production recorded. Quantity and bundle changes require opening a new order."
                    )));
                }

                // Allow the original operator to continue the work order; keep ownership aligned with current login.
                let update_operator = if normalized_owner.is_empty() {
                    operator_id
                } else {
                    owner_operator_trimmed
                };

                conn.exec_drop(
                    "UPDATE work_orders \
                     SET app_user_id = ?, operator_id = ?, machine_id = COALESCE(?, machine_id), quantity_total = ?, bundle_count = ?, updated_at = CURRENT_TIMESTAMP \
                     WHERE id = ?",
                    (
                        app_user_id,
                        update_operator,
                        machine_id_value.as_deref(),
                        quantity_total,
                        bundle_count,
                        work_order_id,
                    ),
                )?;

                let coils = fetch_product_wires(state, reference, role)?;
                let wire_total: usize = coils.iter().map(|coil| coil.wires.len()).sum();
                store_wires_for_order(
                    conn,
                    work_order_id,
                    &coils,
                    order.quantity_total,
                    order.bundle_count,
                )?;
                logging::log_info(&format!(
                    "Order {of_id}/{reference} refreshed for operator {operator_id}: {wire_total} wire(s), quantity {quantity_total}, bundles {bundle_count}",
                ));
                refresh_order_status(conn, work_order_id)?;
            }
            None => {
                conn.exec_drop(
                    "INSERT INTO work_orders (app_user_id, operator_id, machine_id, of_id, reference, quantity_total, bundle_count, status) \
                     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')",
                    (
                        app_user_id,
                        operator_id,
                        machine_id_value.as_deref(),
                        of_id,
                        reference,
                        quantity_total,
                        bundle_count,
                    ),
                )?;

                let work_order_id: Option<u64> = conn.exec_first(
                    "SELECT id FROM work_orders WHERE of_id = ? AND reference = ?",
                    (of_id, reference),
                )?;

                let work_order_id = work_order_id.ok_or_else(|| {
                    AppError::Config(format!(
                        "Unable to load persisted work order for OF {}",
                        of_id
                    ))
                })?;

                let coils = fetch_product_wires(state, reference, role)?;
                let wire_total: usize = coils.iter().map(|coil| coil.wires.len()).sum();
                store_wires_for_order(
                    conn,
                    work_order_id,
                    &coils,
                    order.quantity_total,
                    order.bundle_count,
                )?;
                logging::log_info(&format!(
                    "Order {of_id}/{reference} added for operator {operator_id}: {wire_total} wire(s), quantity {}, bundles {}",
                    order.quantity_total,
                    order.bundle_count,
                ));
                refresh_order_status(conn, work_order_id)?;
            }
        }
    }

    Ok(())
}

fn load_orders_for_session(
    conn: &mut PooledConn,
    app_user_id: &str,
    operator_id: &str,
    allowed: Option<&HashSet<String>>,
) -> Result<Vec<WorkOrderSummary>, AppError> {
    let order_rows: Vec<Row> = conn.exec(
        "SELECT id, of_id, reference, quantity_total, bundle_count, status, machine_id FROM work_orders WHERE app_user_id = ? AND operator_id = ? ORDER BY created_at",
        (app_user_id, operator_id),
    )?;

    let mut summaries = Vec::with_capacity(order_rows.len());
    for mut row in order_rows {
        if env_debug_enabled() {
            println!("order row raw: {:?}", row);
        }
        let order_id: u64 = row.take("id").unwrap_or_default();
        let of_id: String = row
            .take::<Option<String>, _>("of_id")
            .unwrap_or(None)
            .unwrap_or_default();
        let reference: String = row
            .take::<Option<String>, _>("reference")
            .unwrap_or(None)
            .unwrap_or_default();
        if let Some(set) = allowed {
            let key = canonicalize_order_key(of_id.as_str(), reference.as_str());
            if !set.contains(&key) {
                continue;
            }
        }
        let quantity_total: i64 = row
            .take::<Option<i64>, _>("quantity_total")
            .unwrap_or(None)
            .unwrap_or(0);
        let bundle_count: i64 = row
            .take::<Option<i64>, _>("bundle_count")
            .unwrap_or(None)
            .unwrap_or(0);
        let status: String = row
            .take::<Option<String>, _>("status")
            .unwrap_or(None)
            .unwrap_or_else(|| "pending".into());
        let machine_id: Option<String> =
            row.take::<Option<String>, _>("machine_id").unwrap_or(None);

        let wires: Vec<WireSummary> = conn.exec_map(
            "SELECT id, ref_coil, ref_wire, marquage, operator_test_done, length_mm, section, color_primary, color_secondary, bundle_count, target_quantity, produced_quantity, status, previous_status, boot_test_done, boot_test_required, boot_test_required_count, boot_test_done_count, wheel_test_done, wheel_test_required, final_test_done, final_test_required, ext1, ext2 FROM order_wires WHERE work_order_id = ? ORDER BY id",
            (order_id,),
            |row: Row| {
                let mut row = row;
                if env_debug_enabled() {
                    println!("wire row raw: {:?}", row);
                }
                if env_debug_enabled() {
                    println!("extract wire id");
                }
                let wire_id: u64 = row.take("id").unwrap_or_default();
                if env_debug_enabled() {
                    println!("extract ref_coil for wire {wire_id}");
                }
                let ref_coil: String = row
                    .take::<Option<String>, _>("ref_coil")
                    .unwrap_or(None)
                    .unwrap_or_default();
                if env_debug_enabled() {
                    println!("extract ref_wire for wire {wire_id}");
                }
                let ref_wire: String = row
                    .take::<Option<String>, _>("ref_wire")
                    .unwrap_or(None)
                    .unwrap_or_default();
                if env_debug_enabled() {
                    println!("extract marquage for wire {wire_id}");
                }
                let marquage: String = row
                    .take::<Option<String>, _>("marquage")
                    .unwrap_or(None)
                    .unwrap_or_default();
                let operator_test_done = row.take::<i64, _>("operator_test_done").unwrap_or(0) != 0;
                if env_debug_enabled() {
                    println!("extract length for wire {wire_id}");
                }
                let length_mm: i32 = row.take::<i64, _>("length_mm").unwrap_or(0) as i32;
                if env_debug_enabled() {
                    println!("extract section for wire {wire_id}");
                }
                let section: Option<f64> = row.take::<Option<f64>, _>("section").unwrap_or(None);
                if env_debug_enabled() {
                    println!("extract color_primary for wire {wire_id}");
                }
                let color_primary: Option<String> = row
                    .take::<Option<String>, _>("color_primary")
                    .unwrap_or(None);
                if env_debug_enabled() {
                    println!("extract color_secondary for wire {wire_id}");
                }
                let color_secondary: Option<String> = row
                    .take::<Option<String>, _>("color_secondary")
                    .unwrap_or(None);
                let bundle_count: i32 = row.take::<i64, _>("bundle_count").unwrap_or(1) as i32;
                let target_quantity: i32 = row.take::<i64, _>("target_quantity").unwrap_or(0) as i32;
                let produced_quantity: i32 = row.take::<i64, _>("produced_quantity").unwrap_or(0) as i32;
                let wire_status_raw: String = row
                    .take::<Option<String>, _>("status")
                    .unwrap_or(None)
                    .unwrap_or_else(|| "not_validated".into());
                let wire_status = normalize_wire_status(wire_status_raw.as_str()).to_string();
                let previous_status_raw: Option<String> =
                    row.take::<Option<String>, _>("previous_status").unwrap_or(None);
                let previous_status = previous_status_raw
                    .as_deref()
                    .map(|value| normalize_wire_status(value).to_string());
                let boot_done = row.take::<i64, _>("boot_test_done").unwrap_or(0) != 0;
                let boot_required_raw = row.take::<i64, _>("boot_test_required").unwrap_or(0) != 0;
                let boot_required_count: i32 =
                    row.take::<i64, _>("boot_test_required_count").unwrap_or(0) as i32;
                let boot_done_count: i32 =
                    row.take::<i64, _>("boot_test_done_count").unwrap_or(0) as i32;
                let wheel_done = row.take::<i64, _>("wheel_test_done").unwrap_or(0) != 0;
                let wheel_required_raw = row.take::<i64, _>("wheel_test_required").unwrap_or(0) != 0;
                let final_done = row.take::<i64, _>("final_test_done").unwrap_or(0) != 0;
                let final_required_raw = row.take::<i64, _>("final_test_required").unwrap_or(0) != 0;
                let ext1_raw: Option<String> = row.take("ext1");
                let ext2_raw: Option<String> = row.take("ext2");

                let progress = if target_quantity > 0 {
                    ((produced_quantity as f32 / target_quantity as f32) * 100.0).clamp(0.0, 100.0)
                } else {
                    0.0
                };

                let boot_required = boot_required_raw
                    || (wire_status == "qc_boot" && (boot_required_count > 0 && !boot_done));
                let wheel_required =
                    wheel_required_raw || (wire_status == "qc_wheel" && !wheel_done);
                let final_required =
                    final_required_raw || (wire_status == "qc_final" && !final_done);

                WireSummary {
                    id: wire_id,
                    ref_coil,
                    ref_wire,
                    marquage,
                    operator_test_done,
                    length_mm,
                    section,
                    color_primary,
                    color_secondary,
                    bundle_count,
                    status: wire_status,
                    previous_status,
                    produced_quantity,
                    target_quantity,
                    progress_percent: progress,
                    boot_test_done: boot_done,
                    boot_test_required: boot_required,
                    boot_test_required_count: boot_required_count,
                    boot_test_done_count: boot_done_count,
                    wheel_test_done: wheel_done,
                    wheel_test_required: wheel_required,
                    final_test_done: final_done,
                    final_test_required: final_required,
                    ext1: ext1_raw.and_then(|value| serde_json::from_str::<ApiWireExt>(&value).ok()),
                    ext2: ext2_raw.and_then(|value| serde_json::from_str::<ApiWireExt>(&value).ok()),
                }
            },
        )?;

        let order_progress = if wires.is_empty() {
            0.0
        } else {
            wires.iter().map(|wire| wire.progress_percent).sum::<f32>() / wires.len() as f32
        };

        let quantity_total_u32 = if quantity_total < 0 {
            0
        } else {
            quantity_total as u32
        };
        let bundle_count_u32 = if bundle_count < 0 {
            0
        } else {
            bundle_count as u32
        };

        summaries.push(WorkOrderSummary {
            id: order_id,
            of_id,
            reference,
            quantity_total: quantity_total_u32,
            bundle_count: bundle_count_u32,
            status,
            progress_percent: order_progress,
            machine_id: machine_id.clone(),
            wires,
        });
    }

    Ok(summaries)
}

fn compute_production_totals(orders: &[WorkOrderSummary]) -> ProductionTotals {
    let total_orders = orders.len();
    let mut total_wires = 0usize;
    let mut validated_wires = 0usize;
    let mut completed_wires = 0usize;
    let mut tests_blocking = 0usize;
    let mut progress_accumulator = 0.0f32;
    let mut active_orders = 0usize;
    let mut completed_orders = 0usize;

    for order in orders {
        total_wires += order.wires.len();
        if order.status == "completed" {
            completed_orders += 1;
        } else if order.status != "pending" {
            active_orders += 1;
        }

        for wire in &order.wires {
            progress_accumulator += wire.progress_percent;
            if wire.status == "validated" {
                validated_wires += 1;
            }
            if wire.status == "completed" {
                completed_wires += 1;
            }
            if matches!(wire.status.as_str(), "qc_boot" | "qc_wheel" | "qc_final") {
                tests_blocking += 1;
            }
        }
    }

    let average_progress = if total_wires > 0 {
        progress_accumulator / total_wires as f32
    } else {
        0.0
    };

    ProductionTotals {
        total_orders,
        active_orders,
        completed_orders,
        total_wires,
        validated_wires,
        completed_wires,
        tests_blocking,
        average_progress,
    }
}

fn compute_quality_requirements_for_quantity(quantity_total: i32) -> (i32, bool, bool) {
    if quantity_total <= 0 {
        (0, false, false)
    } else if quantity_total <= 100 {
        (1, false, false)
    } else if quantity_total <= 500 {
        (1, false, true)
    } else {
        (3, true, true)
    }
}

fn refresh_order_status(conn: &mut PooledConn, order_id: u64) -> Result<(), AppError> {
    let counts: Option<(i64, i64, i64)> = conn.exec_first(
        "SELECT \
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status IN ('validated','in_production','qc_boot','qc_wheel','qc_final','paused') THEN 1 ELSE 0 END) AS active
         FROM order_wires WHERE work_order_id = ?",
        (order_id,),
    )?;

    if let Some((total, completed, active)) = counts {
        let new_status = if total > 0 && completed == total {
            "completed"
        } else if active > 0 {
            "in_progress"
        } else {
            "pending"
        };

        conn.exec_drop(
            "UPDATE work_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (new_status, order_id),
        )?;
    }

    Ok(())
}

fn build_production_snapshot(state: &AppState) -> Result<ProductionSnapshot, AppError> {
    let snapshot = match current_session_snapshot(state) {
        Ok(snapshot) => snapshot,
        Err(AppError::Config(_)) => {
            return Ok(ProductionSnapshot {
                totals: ProductionTotals {
                    total_orders: 0,
                    active_orders: 0,
                    completed_orders: 0,
                    total_wires: 0,
                    validated_wires: 0,
                    completed_wires: 0,
                    tests_blocking: 0,
                    average_progress: 0.0,
                },
                orders: Vec::new(),
            });
        }
        Err(err) => return Err(err),
    };
    let pool = state.app_pool()?;
    let mut conn = pool.get_conn()?;
    ensure_workflow_tables(&mut conn)?;
    let orders = load_orders_for_session(
        &mut conn,
        &snapshot.user_id,
        &snapshot.operator_id,
        if snapshot.active_orders.is_empty() {
            None
        } else {
            Some(&snapshot.active_orders)
        },
    )?;
    let totals = compute_production_totals(&orders);
    Ok(ProductionSnapshot { totals, orders })
}

fn apply_wire_validation(
    conn: &mut PooledConn,
    session: &SessionSnapshot,
    identifier: &WireIdentifier,
) -> Result<(), AppError> {
    logging::log_info(&format!("Starting wire validation for wire {} in order {}", identifier.ref_wire, identifier.work_order_id));
    let row = conn
        .exec_first::<Row, _, _>(
            "SELECT ow.id, ow.work_order_id, wo.app_user_id, wo.operator_id, wo.of_id, wo.reference, \
                    ow.status, ow.ref_coil, ow.ref_wire \
             FROM order_wires ow \
             JOIN work_orders wo ON ow.work_order_id = wo.id \
             WHERE ow.work_order_id = ? AND ow.ref_wire = ? AND ow.marquage = ?",
            (
                identifier.work_order_id,
                identifier.ref_wire.as_str(),
                identifier.marquage.as_str(),
            ),
        )?
        .ok_or_else(|| {
            logging::log_error(&format!("Wire not found for validation: work_order_id={}, ref_wire={}, marquage={}",
                identifier.work_order_id, identifier.ref_wire, identifier.marquage));
            AppError::Config("Wire not found for validation.".into())
        })?;

    let wire_id: u64 = row.get("id").unwrap_or_default();
    let work_order_id: u64 = row.get("work_order_id").unwrap_or_default();
    let row_app_user: Option<String> = row.get_opt("app_user_id").unwrap_or(Ok(None)).unwrap_or(None);
    let row_operator: Option<String> = row.get_opt("operator_id").unwrap_or(Ok(None)).unwrap_or(None);
    let status: Option<String> = row.get_opt("status").unwrap_or(Ok(None)).unwrap_or(None);
    let order_of: Option<String> = row.get_opt("of_id").unwrap_or(Ok(None)).unwrap_or(None);
    let order_reference: Option<String> = row.get_opt("reference").unwrap_or(Ok(None)).unwrap_or(None);
    let ref_coil: Option<String> = row.get_opt("ref_coil").unwrap_or(Ok(None)).unwrap_or(None);
    let ref_wire: Option<String> = row.get_opt("ref_wire").unwrap_or(Ok(None)).unwrap_or(None);

    let row_app_user = row_app_user.unwrap_or_default();
    let row_operator = row_operator.unwrap_or_default();
    let status = status.unwrap_or_else(|| "not_validated".into());
    let order_of = order_of.unwrap_or_default();
    let order_reference = order_reference.unwrap_or_default();
    let ref_coil = ref_coil.unwrap_or_default();
    let ref_wire = ref_wire.unwrap_or_else(|| identifier.ref_wire.clone());

    let wire_context =
        summarize_wire_context(&order_of, &order_reference, identifier.ref_wire.as_str());

    if row_app_user != session.user_id || row_operator != session.operator_id {
        return Err(AppError::Config(
            "Wire does not belong to the active session.".into(),
        ));
    }
    if status == "completed" {
        return Err(AppError::Config(
            "Completed wires cannot be re-validated.".into(),
        ));
    }

    conn.exec_drop(
        "UPDATE order_wires ow \
         JOIN work_orders wo ON ow.work_order_id = wo.id \
         SET ow.status = 'not_validated', ow.previous_status = NULL \
         WHERE wo.app_user_id = ? AND wo.operator_id = ? AND ow.status IN ('validated','qc_boot') AND ow.id <> ?",
        (session.user_id.as_str(), session.operator_id.as_str(), wire_id),
    )?;
    conn.exec_drop(
        "UPDATE order_wires SET status = 'validated', previous_status = NULL WHERE id = ?",
        (wire_id,),
    )?;
    refresh_order_status(conn, work_order_id)?;

    insert_session_log(
        conn,
        session,
        "CHANGE_COIL",
        "Coil validated",
        Some(order_of.as_str()),
        Some(order_reference.as_str()),
        Some(ref_wire.as_str()),
        if ref_coil.trim().is_empty() {
            None
        } else {
            Some(ref_coil.as_str())
        },
        None,
        None,
        None,
        None,
    )?;

    logging::log_info(&format!(
        "Wire validation completed for {}",
        wire_context.as_str()
    ));

    Ok(())
}

fn apply_pause_wire(
    conn: &mut PooledConn,
    session: &SessionSnapshot,
    identifier: &WireIdentifier,
) -> Result<(), AppError> {
    let row = conn
        .exec_first::<Row, _, _>(
            "SELECT ow.id, ow.work_order_id, wo.app_user_id, wo.operator_id, ow.status, \
                    wo.of_id, wo.reference, ow.ref_coil, ow.produced_quantity \
             FROM order_wires ow \
             JOIN work_orders wo ON ow.work_order_id = wo.id \
             WHERE ow.work_order_id = ? AND ow.ref_wire = ? AND ow.marquage = ?",
            (
                identifier.work_order_id,
                identifier.ref_wire.as_str(),
                identifier.marquage.as_str(),
            ),
        )?
        .ok_or_else(|| AppError::Config("Wire not found.".into()))?;

    let mut row = row;
    let wire_id: u64 = row.take("id").unwrap_or_default();
    let work_order_id: u64 = row.take("work_order_id").unwrap_or_default();
    let row_app_user: String = row
        .take::<Option<String>, _>("app_user_id")
        .unwrap_or(None)
        .unwrap_or_default();
    let row_operator: String = row
        .take::<Option<String>, _>("operator_id")
        .unwrap_or(None)
        .unwrap_or_default();
    let current_status: String = row
        .take::<Option<String>, _>("status")
        .unwrap_or(None)
        .unwrap_or_else(|| "not_validated".into());
    let order_of: String = row
        .take::<Option<String>, _>("of_id")
        .unwrap_or(None)
        .unwrap_or_default();
    let order_reference: String = row
        .take::<Option<String>, _>("reference")
        .unwrap_or(None)
        .unwrap_or_default();
    let ref_coil: String = row
        .take::<Option<String>, _>("ref_coil")
        .unwrap_or(None)
        .unwrap_or_default();
    let produced_quantity: i32 = row.take::<i64, _>("produced_quantity").unwrap_or(0) as i32;

    if row_app_user != session.user_id || row_operator != session.operator_id {
        return Err(AppError::Config(
            "Wire does not belong to the active session.".into(),
        ));
    }
    if matches!(current_status.as_str(), "completed" | "stopped") {
        return Err(AppError::Config(
            "Cannot pause a wire that is completed or stopped.".into(),
        ));
    }
    if current_status == "paused" {
        return Ok(());
    }

    conn.exec_drop(
        "UPDATE order_wires SET previous_status = status, status = 'paused', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (wire_id,),
    )?;
    refresh_order_status(conn, work_order_id)?;

    insert_session_log(
        conn,
        session,
        "PAUSE",
        &format!("Production paused at {} units", produced_quantity),
        Some(order_of.as_str()),
        Some(order_reference.as_str()),
        Some(identifier.ref_wire.as_str()),
        if ref_coil.trim().is_empty() {
            None
        } else {
            Some(ref_coil.as_str())
        },
        Some(produced_quantity as f64),
        None,
        None,
        None,
    )?;

    logging::log_info(&format!(
        "Wire paused at {} units for {}",
        produced_quantity,
        summarize_wire_context(&order_of, &order_reference, identifier.ref_wire.as_str())
    ));

    Ok(())
}

fn apply_stop_wire(
    conn: &mut PooledConn,
    session: &SessionSnapshot,
    identifier: &WireIdentifier,
) -> Result<(), AppError> {
    let row = conn
        .exec_first::<Row, _, _>(
            "SELECT ow.id, ow.work_order_id, wo.app_user_id, wo.operator_id, ow.status, \
                    wo.of_id, wo.reference, ow.ref_coil, ow.produced_quantity \
             FROM order_wires ow \
             JOIN work_orders wo ON ow.work_order_id = wo.id \
             WHERE ow.work_order_id = ? AND ow.ref_wire = ? AND ow.marquage = ?",
            (
                identifier.work_order_id,
                identifier.ref_wire.as_str(),
                identifier.marquage.as_str(),
            ),
        )?
        .ok_or_else(|| AppError::Config("Wire not found.".into()))?;

    let mut row = row;
    let wire_id: u64 = row.take("id").unwrap_or_default();
    let work_order_id: u64 = row.take("work_order_id").unwrap_or_default();
    let row_app_user: String = row
        .take::<Option<String>, _>("app_user_id")
        .unwrap_or(None)
        .unwrap_or_default();
    let row_operator: String = row
        .take::<Option<String>, _>("operator_id")
        .unwrap_or(None)
        .unwrap_or_default();
    let current_status: String = row
        .take::<Option<String>, _>("status")
        .unwrap_or(None)
        .unwrap_or_else(|| "not_validated".into());
    let order_of: String = row
        .take::<Option<String>, _>("of_id")
        .unwrap_or(None)
        .unwrap_or_default();
    let order_reference: String = row
        .take::<Option<String>, _>("reference")
        .unwrap_or(None)
        .unwrap_or_default();
    let ref_coil: String = row
        .take::<Option<String>, _>("ref_coil")
        .unwrap_or(None)
        .unwrap_or_default();
    let produced_quantity: i32 = row.take::<i64, _>("produced_quantity").unwrap_or(0) as i32;

    if row_app_user != session.user_id || row_operator != session.operator_id {
        return Err(AppError::Config(
            "Wire does not belong to the active session.".into(),
        ));
    }
    if matches!(current_status.as_str(), "completed" | "stopped") {
        return Err(AppError::Config(
            "Cannot stop a wire that is already completed or stopped.".into(),
        ));
    }

    conn.exec_drop(
        "UPDATE order_wires SET previous_status = status, status = 'stopped', stopped_by_user = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (session.user_id.as_str(), wire_id),
    )?;
    refresh_order_status(conn, work_order_id)?;

    insert_session_log(
        conn,
        session,
        "STOP",
        &format!("Production stopped at {} units", produced_quantity),
        Some(order_of.as_str()),
        Some(order_reference.as_str()),
        Some(identifier.ref_wire.as_str()),
        if ref_coil.trim().is_empty() {
            None
        } else {
            Some(ref_coil.as_str())
        },
        Some(produced_quantity as f64),
        None,
        None,
        None,
    )?;

    logging::log_info(&format!(
        "Wire stopped at {} units for {}",
        produced_quantity,
        summarize_wire_context(&order_of, &order_reference, identifier.ref_wire.as_str())
    ));

    Ok(())
}

fn apply_resume_wire(
    conn: &mut PooledConn,
    session: &SessionSnapshot,
    identifier: &WireIdentifier,
) -> Result<(), AppError> {
    let row = conn
        .exec_first::<Row, _, _>(
            "SELECT ow.id, ow.work_order_id, wo.app_user_id, wo.operator_id, ow.status, ow.previous_status, \
                    ow.target_quantity, ow.produced_quantity, ow.boot_test_required, ow.boot_test_required_count, ow.boot_test_done_count, \
                    ow.wheel_test_required, ow.wheel_test_done, ow.final_test_required, ow.final_test_done \
             FROM order_wires ow \
             JOIN work_orders wo ON ow.work_order_id = wo.id \
             WHERE ow.work_order_id = ? AND ow.ref_wire = ? AND ow.marquage = ?",
            (
                identifier.work_order_id,
                identifier.ref_wire.as_str(),
                identifier.marquage.as_str(),
            ),
        )?
        .ok_or_else(|| AppError::Config("Wire not found.".into()))?;

    let mut row = row;
    let wire_id: u64 = row.take("id").unwrap_or_default();
    let work_order_id: u64 = row.take("work_order_id").unwrap_or_default();
    let row_app_user: String = row
        .take::<Option<String>, _>("app_user_id")
        .unwrap_or(None)
        .unwrap_or_default();
    let row_operator: String = row
        .take::<Option<String>, _>("operator_id")
        .unwrap_or(None)
        .unwrap_or_default();
    let status: String = row
        .take::<Option<String>, _>("status")
        .unwrap_or(None)
        .unwrap_or_else(|| "not_validated".into());
    let _ = &status;
    let previous_status: Option<String> = row
        .take::<Option<String>, _>("previous_status")
        .unwrap_or(None);
    let _target_quantity: i32 = row.take::<i64, _>("target_quantity").unwrap_or(0) as i32;
    let produced_quantity: i32 = row.take::<i64, _>("produced_quantity").unwrap_or(0) as i32;
    let boot_required = row.take::<i64, _>("boot_test_required").unwrap_or(0) != 0;
    let boot_required_count: i32 =
        row.take::<i64, _>("boot_test_required_count").unwrap_or(1) as i32;
    let boot_done_count: i32 = row.take::<i64, _>("boot_test_done_count").unwrap_or(0) as i32;
    let wheel_required = row.take::<i64, _>("wheel_test_required").unwrap_or(0) != 0;
    let wheel_done = row.take::<i64, _>("wheel_test_done").unwrap_or(0) != 0;
    let final_required = row.take::<i64, _>("final_test_required").unwrap_or(0) != 0;
    let final_done = row.take::<i64, _>("final_test_done").unwrap_or(0) != 0;

    if row_app_user != session.user_id || row_operator != session.operator_id {
        return Err(AppError::Config(
            "Wire does not belong to the active session.".into(),
        ));
    }
    if status != "paused" {
        return Err(AppError::Config("Only paused wires can be resumed.".into()));
    }

    let boot_pending = boot_required && boot_done_count < boot_required_count.max(1);
    let wheel_hold = wheel_required && !wheel_done;
    let final_hold = final_required && !final_done;

    let fallback_status = if boot_pending {
        "qc_boot".to_string()
    } else if wheel_hold {
        "qc_wheel".to_string()
    } else if final_hold {
        "qc_final".to_string()
    } else if produced_quantity > 0 {
        "in_production".to_string()
    } else {
        "validated".to_string()
    };

    let next_status = previous_status
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_status);

    conn.exec_drop(
        "UPDATE order_wires SET status = ?, previous_status = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (next_status.as_str(), wire_id),
    )?;
    refresh_order_status(conn, work_order_id)?;
    logging::log_info(&format!(
        "Wire {} resumed to status {} (work order {})",
        identifier.ref_wire.as_str(),
        next_status,
        identifier.work_order_id
    ));
    Ok(())
}

fn apply_wire_progress(
    conn: &mut PooledConn,
    session: &SessionSnapshot,
    payload: &WireProgressRequest,
) -> Result<(), AppError> {
    if payload.produced_increment <= 0 {
        return Err(AppError::Config(
            "Produced quantity increment must be a positive value.".into(),
        ));
    }

    let identifier = &payload.wire;
    let row = conn
        .exec_first::<Row, _, _>(
            "SELECT ow.id, ow.work_order_id, wo.app_user_id, wo.operator_id, \
                    ow.target_quantity, ow.bundle_count, ow.produced_quantity, ow.status, ow.previous_status, \
                    ow.boot_test_done, ow.boot_test_required, ow.boot_test_required_count, ow.boot_test_done_count, \
                    ow.wheel_test_done, ow.wheel_test_required, \
                    ow.final_test_done, ow.final_test_required, \
                    wo.of_id, wo.reference, ow.ref_coil \
             FROM order_wires ow \
             JOIN work_orders wo ON ow.work_order_id = wo.id \
             WHERE ow.work_order_id = ? AND ow.ref_wire = ? AND ow.marquage = ?",
            (
                identifier.work_order_id,
                identifier.ref_wire.as_str(),
                identifier.marquage.as_str(),
            ),
        )?
        .ok_or_else(|| AppError::Config("Wire not found.".into()))?;

    let mut row = row;
    let wire_id: u64 = row.take("id").unwrap_or_default();
    let work_order_id: u64 = row.take("work_order_id").unwrap_or_default();
    let row_app_user: String = row
        .take::<Option<String>, _>("app_user_id")
        .unwrap_or(None)
        .unwrap_or_default();
    let row_operator: String = row
        .take::<Option<String>, _>("operator_id")
        .unwrap_or(None)
        .unwrap_or_default();
    let target_quantity: i32 = row.take::<i64, _>("target_quantity").unwrap_or(0) as i32;
    let bundle_count: i32 = row.take::<i64, _>("bundle_count").unwrap_or(0) as i32;
    let produced_quantity: i32 = row.take::<i64, _>("produced_quantity").unwrap_or(0) as i32;
    let mut status: String = row
        .take::<Option<String>, _>("status")
        .unwrap_or(None)
        .unwrap_or_else(|| "not_validated".into());
    let _previous_status: Option<String> = row
        .take::<Option<String>, _>("previous_status")
        .unwrap_or(None);
    let _boot_done = row.take::<i64, _>("boot_test_done").unwrap_or(0) != 0;
    let boot_required = row.take::<i64, _>("boot_test_required").unwrap_or(0) != 0;
    let boot_required_count: i32 =
        row.take::<i64, _>("boot_test_required_count").unwrap_or(1) as i32;
    let boot_done_count: i32 = row.take::<i64, _>("boot_test_done_count").unwrap_or(0) as i32;
    let mut wheel_required_flag = row.take::<i64, _>("wheel_test_required").unwrap_or(0) != 0;
    let wheel_done = row.take::<i64, _>("wheel_test_done").unwrap_or(0) != 0;
    let final_required_flag = row.take::<i64, _>("final_test_required").unwrap_or(0) != 0;
    let final_done = row.take::<i64, _>("final_test_done").unwrap_or(0) != 0;
    let order_of: String = row
        .take::<Option<String>, _>("of_id")
        .unwrap_or(None)
        .unwrap_or_default();
    let order_reference: String = row
        .take::<Option<String>, _>("reference")
        .unwrap_or(None)
        .unwrap_or_default();
    let ref_coil: String = row
        .take::<Option<String>, _>("ref_coil")
        .unwrap_or(None)
        .unwrap_or_default();
    let wire_context =
        summarize_wire_context(&order_of, &order_reference, identifier.ref_wire.as_str());

    if row_app_user != session.user_id || row_operator != session.operator_id {
        return Err(AppError::Config(
            "Wire does not belong to the active session.".into(),
        ));
    }

    let target = target_quantity.max(0);
    let _bundles = bundle_count.max(1);
    let new_total = produced_quantity.saturating_add(payload.produced_increment);

    let boot_pending = boot_required && boot_done_count < boot_required_count.max(1);

    match status.as_str() {
        "not_validated" => {
            return Err(AppError::Config(
                "Validate the wire before recording production.".into(),
            ));
        }
        "paused" => {
            return Err(AppError::Config(
                "Resume the wire before recording production.".into(),
            ));
        }
        "stopped" => {
            return Err(AppError::Config("Stopped wires cannot be produced.".into()));
        }
        "completed" => {
            return Err(AppError::Config(
                "Completed wires cannot be produced.".into(),
            ));
        }
        "qc_final" if !final_done => {
            return Err(AppError::Config(
                "Final quality test pending. Complete the final test before continuing production."
                    .into(),
            ));
        }
        _ => {}
    }

    let wheel_threshold = if target > 0 {
        ((target as f64) * 0.5).ceil() as i32
    } else {
        0
    };

    if target > 500 && !wheel_done && new_total >= wheel_threshold {
        if status != "qc_wheel" {
            conn.exec_drop(
                "UPDATE order_wires SET wheel_test_required = TRUE, status = 'qc_wheel', previous_status = 'in_production', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (wire_id,),
            )?;
            status = "qc_wheel".into();
        } else if !wheel_required_flag {
            conn.exec_drop(
                "UPDATE order_wires SET wheel_test_required = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (wire_id,),
            )?;
        }
        wheel_required_flag = true;
    }

    if target > 0 && new_total >= target {
        let completion_total = if target > 0 { target } else { new_total };
        let boot_pending_now = boot_pending;
        if boot_pending_now {
            conn.exec_drop(
                "UPDATE order_wires SET produced_quantity = ?, boot_test_required = TRUE, status = 'qc_boot', previous_status = 'in_production', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (completion_total, wire_id),
            )?;
            refresh_order_status(conn, work_order_id)?;
            return Err(AppError::Config(
                "Boot test pending. Complete the boot test before closing production.".into(),
            ));
        }

        let wheel_pending_now = wheel_required_flag && !wheel_done;
        if wheel_pending_now {
            conn.exec_drop(
                "UPDATE order_wires SET produced_quantity = ?, wheel_test_required = TRUE, status = 'qc_wheel', previous_status = 'in_production', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (completion_total, wire_id),
            )?;
            refresh_order_status(conn, work_order_id)?;
            logging::log_info(&format!(
                "Wire {} reached wheel test threshold at {} units",
                wire_context.as_str(),
                completion_total
            ));
            return Ok(());
        }

        let final_pending_now = !final_done && (final_required_flag || target >= 101);
        if final_pending_now {
            conn.exec_drop(
                "UPDATE order_wires SET produced_quantity = ?, final_test_required = TRUE, status = 'qc_final', previous_status = 'in_production', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (completion_total, wire_id),
            )?;
            refresh_order_status(conn, work_order_id)?;
            logging::log_info(&format!(
                "Wire {} awaiting final quality validation at {} units",
                wire_context.as_str(),
                completion_total
            ));
            return Ok(());
        }

        let final_status = if completion_total > 0 {
            "qc_final"
        } else {
            "validated"
        };
        conn.exec_drop(
            "UPDATE order_wires SET produced_quantity = ?, status = ?, previous_status = CASE WHEN ? THEN 'in_production' ELSE previous_status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (
                completion_total,
                final_status,
                matches!(final_status, "qc_final"),
                wire_id,
            ),
        )?;
        refresh_order_status(conn, work_order_id)?;
        logging::log_info(&format!(
            "Wire {} completed production at {} units (status {})",
            wire_context.as_str(),
            completion_total,
            final_status
        ));
        return Ok(());
    }

    let mut new_status = status.clone();
    if new_total > 0 {
        if status == "validated" && boot_pending {
            new_status = "qc_boot".into();
        } else if status == "validated" && !boot_pending {
            new_status = "in_production".into();
        } else if status == "qc_boot" && !boot_pending {
            new_status = "in_production".into();
        }
    }

    conn.exec_drop(
        "UPDATE order_wires SET produced_quantity = ?, status = ?, previous_status = CASE WHEN ? THEN NULL ELSE previous_status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (
            new_total,
            new_status.as_str(),
            matches!(new_status.as_str(), "in_production" | "qc_boot"),
            wire_id,
        ),
    )?;
    refresh_order_status(conn, work_order_id)?;

    if produced_quantity == 0 && new_total > 0 {
        insert_session_log(
            conn,
            session,
            "START",
            &format!("Production started ({} units)", new_total),
            Some(order_of.as_str()),
            Some(order_reference.as_str()),
            Some(identifier.ref_wire.as_str()),
            if ref_coil.trim().is_empty() {
                None
            } else {
                Some(ref_coil.as_str())
            },
            Some(new_total as f64),
            None,
            None,
            None,
        )?;
        logging::log_info(&format!(
            "Production started for {} with initial quantity {}",
            wire_context.as_str(),
            new_total
        ));
    }

    logging::log_info(&format!(
        "Recorded production increment of {} units for {} (total {})",
        payload.produced_increment,
        wire_context.as_str(),
        new_total
    ));

    Ok(())
}

fn apply_wire_finalization(
    conn: &mut PooledConn,
    session: &SessionSnapshot,
    request: &FinalizeWireRequest,
) -> Result<(), AppError> {
    let identifier = &request.wire;
    let quality_agent_id = match request
        .quality_agent_id
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        Some(value) => value.to_string(),
        None => {
            logging::log_warn(&format!(
                "Production validation rejected for wire {}: missing quality agent id",
                identifier.ref_wire
            ));
            return Err(AppError::Config(
                "Quality agent authentication is required before validating production.".into(),
            ));
        }
    };

    let row = conn
        .exec_first::<Row, _, _>(
            "SELECT ow.id, ow.work_order_id, wo.app_user_id, wo.operator_id, \
                    ow.status, ow.previous_status, ow.ref_coil, ow.produced_quantity, ow.target_quantity, \
                    ow.boot_test_done, ow.boot_test_required, ow.boot_test_required_count, ow.boot_test_done_count, \
                    ow.wheel_test_done, ow.wheel_test_required, \
                    ow.final_test_done, ow.final_test_required, \
                    wo.of_id, wo.reference \
             FROM order_wires ow \
             JOIN work_orders wo ON ow.work_order_id = wo.id \
             WHERE ow.work_order_id = ? AND ow.ref_wire = ? AND ow.marquage = ?",
            (
                identifier.work_order_id,
                identifier.ref_wire.as_str(),
                identifier.marquage.as_str(),
            ),
        )?
        .ok_or_else(|| AppError::Config("Wire not found for production validation.".into()))?;

    let mut row = row;
    let wire_id: u64 = row.take("id").unwrap_or_default();
    let work_order_id: u64 = row.take("work_order_id").unwrap_or_default();
    let row_app_user: String = row
        .take::<Option<String>, _>("app_user_id")
        .unwrap_or(None)
        .unwrap_or_default();
    let row_operator: String = row
        .take::<Option<String>, _>("operator_id")
        .unwrap_or(None)
        .unwrap_or_default();
    let status: String = row
        .take::<Option<String>, _>("status")
        .unwrap_or(None)
        .unwrap_or_else(|| "not_validated".into());
    let previous_status: Option<String> = row
        .take::<Option<String>, _>("previous_status")
        .unwrap_or(None)
        .filter(|value| !value.is_empty());
    let ref_coil: String = row
        .take::<Option<String>, _>("ref_coil")
        .unwrap_or(None)
        .unwrap_or_default();
    let produced_quantity: i32 = row.take::<i64, _>("produced_quantity").unwrap_or(0) as i32;
    let target_quantity: i32 = row.take::<i64, _>("target_quantity").unwrap_or(0) as i32;
    let boot_done = row.take::<i64, _>("boot_test_done").unwrap_or(0) != 0;
    let boot_required_flag = row.take::<i64, _>("boot_test_required").unwrap_or(0) != 0;
    let boot_required_count: i32 =
        row.take::<i64, _>("boot_test_required_count").unwrap_or(0) as i32;
    let boot_done_count: i32 = row.take::<i64, _>("boot_test_done_count").unwrap_or(0) as i32;
    let wheel_done = row.take::<i64, _>("wheel_test_done").unwrap_or(0) != 0;
    let wheel_required_flag = row.take::<i64, _>("wheel_test_required").unwrap_or(0) != 0;
    let final_done = row.take::<i64, _>("final_test_done").unwrap_or(0) != 0;
    let final_required_flag = row.take::<i64, _>("final_test_required").unwrap_or(0) != 0;
    let order_of: String = row
        .take::<Option<String>, _>("of_id")
        .unwrap_or(None)
        .unwrap_or_default();
    let order_reference: String = row
        .take::<Option<String>, _>("reference")
        .unwrap_or(None)
        .unwrap_or_default();
    let wire_context =
        summarize_wire_context(&order_of, &order_reference, identifier.ref_wire.as_str());

    if row_app_user != session.user_id || row_operator != session.operator_id {
        return Err(AppError::Config(
            "Wire does not belong to the active session.".into(),
        ));
    }

    if status == "completed" {
        return Err(AppError::Config(
            "Production already validated for this wire.".into(),
        ));
    }

    if matches!(status.as_str(), "stopped" | "paused") {
        return Err(AppError::Config(
            "Resume production before validating the wire.".into(),
        ));
    }

    let (expected_boot_count, expect_wheel_anytime, expect_final_anytime) =
        compute_quality_requirements_for_quantity(target_quantity);

    let normalized_boot_required = boot_required_count
        .max(expected_boot_count)
        .max(if boot_required_flag { 1 } else { 0 });
    let boot_complete = if normalized_boot_required > 0 {
        boot_done && boot_done_count >= normalized_boot_required
    } else {
        true
    };

    let wheel_required = wheel_required_flag || expect_wheel_anytime;
    let wheel_complete = if wheel_required { wheel_done } else { true };

    let final_required = final_required_flag || expect_final_anytime || target_quantity >= 101;
    let final_complete = if final_required { final_done } else { true };

    if !boot_complete || !wheel_complete || !final_complete {
        return Err(AppError::Config(
            "Complete all required quality tests before validating production.".into(),
        ));
    }

    if target_quantity > 0 && produced_quantity < target_quantity {
        return Err(AppError::Config(
            "Reach the production target before validating this wire.".into(),
        ));
    }

    if target_quantity <= 0 && produced_quantity <= 0 {
        return Err(AppError::Config(
            "Record production for the wire before validating.".into(),
        ));
    }

    let completion_units = if target_quantity > 0 {
        target_quantity
    } else {
        produced_quantity
    }
    .max(0);

    conn.exec_drop(
        "UPDATE order_wires \
         SET produced_quantity = ?, status = 'completed', previous_status = NULL, updated_at = CURRENT_TIMESTAMP \
         WHERE id = ?",
        (completion_units, wire_id),
    )?;

    refresh_order_status(conn, work_order_id)?;

    let note = if previous_status.as_deref() == Some("qc_final") || status == "qc_final" {
        format!(
            "Production validated after quality controls by QA {}",
            quality_agent_id
        )
    } else {
        format!("Production validated by QA {}", quality_agent_id)
    };

    insert_session_log(
        conn,
        session,
        "END",
        &note,
        Some(order_of.as_str()),
        Some(order_reference.as_str()),
        Some(identifier.ref_wire.as_str()),
        if ref_coil.trim().is_empty() {
            None
        } else {
            Some(ref_coil.as_str())
        },
        Some(completion_units as f64),
        None,
        None,
        None,
    )?;

    logging::log_info(&format!(
        "Production finalized for {} by QA {} validating {} unit(s)",
        wire_context.as_str(),
        quality_agent_id,
        completion_units
    ));

    Ok(())
}

fn apply_quality_test(
    state: &AppState,
    conn: &mut PooledConn,
    session: &SessionSnapshot,
    req: &QualityTestRequest,
) -> Result<QualityTestResultPayload, AppError> {
    let identifier = &req.wire;
    let quality_agent_id = match req
        .quality_agent_id
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        Some(value) => value.to_string(),
        None => {
            logging::log_warn(&format!(
                "Quality test rejected for wire {}: missing quality agent id",
                identifier.ref_wire
            ));
            return Err(AppError::Config(
                "Quality agent authentication is required before performing this test.".into(),
            ));
        }
    };
    let row = conn
        .exec_first::<Row, _, _>(
            "SELECT ow.id, ow.work_order_id, wo.app_user_id, wo.operator_id, \
                    wo.of_id, wo.reference, wo.machine_id, \
                    ow.ref_coil, ow.length_mm, ow.ext1, ow.ext2, \
                    ow.target_quantity, ow.produced_quantity, ow.status, \
                    ow.boot_test_done, ow.boot_test_required, ow.boot_test_required_count, ow.boot_test_done_count, \
                    ow.wheel_test_done, ow.wheel_test_required, \
                    ow.final_test_done, ow.final_test_required \
             FROM order_wires ow \
             JOIN work_orders wo ON ow.work_order_id = wo.id \
             WHERE ow.work_order_id = ? AND ow.ref_wire = ? AND ow.marquage = ?",
            (
                identifier.work_order_id,
                identifier.ref_wire.as_str(),
                identifier.marquage.as_str(),
            ),
        )?
        .ok_or_else(|| AppError::Config("Wire not found for quality update.".into()))?;

    let mut row = row;
    let wire_id: u64 = row.take("id").unwrap_or_default();
    let work_order_id: u64 = row.take("work_order_id").unwrap_or_default();
    let row_app_user: String = row
        .take::<Option<String>, _>("app_user_id")
        .unwrap_or(None)
        .unwrap_or_default();
    let row_operator: String = row
        .take::<Option<String>, _>("operator_id")
        .unwrap_or(None)
        .unwrap_or_default();
    let order_of: String = row
        .take::<Option<String>, _>("of_id")
        .unwrap_or(None)
        .unwrap_or_default();
    let order_reference: String = row
        .take::<Option<String>, _>("reference")
        .unwrap_or(None)
        .unwrap_or_default();
    let order_machine: Option<String> = row.take("machine_id");
    let ref_coil: String = row
        .take::<Option<String>, _>("ref_coil")
        .unwrap_or(None)
        .unwrap_or_default();
    let wire_context =
        summarize_wire_context(&order_of, &order_reference, identifier.ref_wire.as_str());
    let length_mm: i32 = row.take::<i64, _>("length_mm").unwrap_or(0) as i32;
    let ext1_raw: Option<String> = row.take("ext1");
    let ext2_raw: Option<String> = row.take("ext2");
    let produced_quantity: i32 = row.take::<i64, _>("produced_quantity").unwrap_or(0) as i32;
    let _status: String = row
        .take::<Option<String>, _>("status")
        .unwrap_or(None)
        .unwrap_or_else(|| "not_validated".into());
    let _boot_done = row.take::<i64, _>("boot_test_done").unwrap_or(0) != 0;
    let boot_required_count: i32 =
        row.take::<i64, _>("boot_test_required_count").unwrap_or(1) as i32;
    let boot_done_count: i32 = row.take::<i64, _>("boot_test_done_count").unwrap_or(0) as i32;
    let wheel_done = row.take::<i64, _>("wheel_test_done").unwrap_or(0) != 0;
    let final_done = row.take::<i64, _>("final_test_done").unwrap_or(0) != 0;

    if row_app_user != session.user_id || row_operator != session.operator_id {
        return Err(AppError::Config(
            "Wire does not belong to the active session.".into(),
        ));
    }

    let ext1: Option<ApiWireExt> =
        ext1_raw.and_then(|value| serde_json::from_str::<ApiWireExt>(&value).ok());
    let ext2: Option<ApiWireExt> =
        ext2_raw.and_then(|value| serde_json::from_str::<ApiWireExt>(&value).ok());

    let spec_left = match ext1.as_ref().and_then(|ext| ext.terminal.as_ref()) {
        Some(terminal) => lookup_crimp_tool_spec(
            state,
            terminal,
            ext1.as_ref().and_then(|ext| ext.joint.as_deref()),
        )?,
        None => None,
    };
    let spec_right = match ext2.as_ref().and_then(|ext| ext.terminal.as_ref()) {
        Some(terminal) => lookup_crimp_tool_spec(
            state,
            terminal,
            ext2.as_ref().and_then(|ext| ext.joint.as_deref()),
        )?,
        None => None,
    };

    let measurements = parse_measurements_from_notes(&req.notes);
    let references = OperatorReferences {
        strip_left: ext1.as_ref().and_then(|ext| ext.stripping),
        strip_right: ext2.as_ref().and_then(|ext| ext.stripping),
        length: if length_mm > 0 {
            Some(length_mm as f64)
        } else {
            None
        },
        spec_left,
        spec_right,
    };

    let mut result = build_test_result(None, &measurements, &references);
    let status_text = match result.overall_passed {
        Some(true) => Some("OK".to_string()),
        Some(false) => Some("NOK".to_string()),
        None => None,
    };
    result.status = status_text.clone();
    match req.test {
        QualityTestKind::Boot => {
            let required_total = boot_required_count.max(1);
            let new_done_count = (boot_done_count + 1).min(required_total);
            let complete = new_done_count >= required_total;
            let next_status: String = if complete {
                if produced_quantity > 0 {
                    "in_production".into()
                } else {
                    "validated".into()
                }
            } else {
                "qc_boot".into()
            };
            conn.exec_drop(
                "UPDATE order_wires SET boot_test_done_count = ?, boot_test_done = ?, boot_test_required = CASE WHEN ? THEN FALSE ELSE boot_test_required END, status = ?, previous_status = CASE WHEN ? THEN NULL ELSE previous_status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (
                    new_done_count,
                    complete,
                    complete,
                    next_status.as_str(),
                    matches!(next_status.as_str(), "validated" | "in_production"),
                    wire_id,
                ),
            )?;
        }
        QualityTestKind::Wheel => {
            if !wheel_done {
                let next_status = if produced_quantity > 0 {
                    "in_production"
                } else {
                    "validated"
                };
                conn.exec_drop(
                    "UPDATE order_wires SET wheel_test_done = TRUE, wheel_test_required = FALSE, status = ?, previous_status = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (next_status, wire_id),
                )?;
            }
        }
        QualityTestKind::Final => {
            if !final_done {
                let final_status = if produced_quantity > 0 {
                    "qc_final"
                } else {
                    "validated"
                };
                conn.exec_drop(
                    "UPDATE order_wires SET final_test_done = TRUE, final_test_required = FALSE, status = ?, previous_status = CASE WHEN ? THEN 'in_production' ELSE previous_status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (final_status, matches!(final_status, "qc_final"), wire_id),
                )?;
            }
        }
    }

    let engine_name = resolve_engine_name();
    let stage_label = describe_quality_stage(req.test);
    let log_note = format!("Quality tests completed ({stage_label}) by QA {quality_agent_id}");
    let photo_front = aggregate_photo_paths(&req.notes, "front");
    let photo_back = aggregate_photo_paths(&req.notes, "back");
    let (photo_left, photo_right) = build_side_path_strings(&photo_front, &photo_back);
    let legacy_path_image = combine_legacy_path_image(
        photo_left.as_deref(),
        photo_right.as_deref(),
        wire_context.as_str(),
    );

    let machine_identifier = order_machine
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .or_else(|| session.machine_id.clone());

    ensure_logging_tables(conn)?;

    conn.exec_drop(
        "INSERT INTO quality_events (event, of_id, ref, ref_coil, side, operator_id, machine_id, note) VALUES ('CONTROL_QUALITY', :of_id, :ref, :ref_coil, NULL, :operator_id, :machine_id, :note)",
        params! {
            "of_id" => order_of.as_str(),
            "ref" => identifier.ref_wire.as_str(),
            "ref_coil" => ref_coil.as_str(),
            "operator_id" => quality_agent_id.as_str(),
            "machine_id" => machine_identifier.as_deref(),
            "note" => log_note.as_str(),
        },
    )?;

    conn.exec_drop(
        "INSERT INTO logs (
            ref_of, ref_product, quantity, status, note, engine_name, user_number,
            app_user_id, app_user_name, op_quality_number, op_maintenance_number,
            ref_wire, ref_coil, ref_tool_1, ref_tool_2,
            control_length, control_stripping_left, control_stripping_right,
            control_crimping_height_left, control_crimping_height_right,
            control_traction_force_left, control_traction_force_right, path_image, path_image_left, path_image_right
        ) VALUES (:ref_of, :ref_product, NULL, 'CONTROL_QUALITY', :note, :engine_name, :user_number,
            :app_user_id, :app_user_name, :op_quality_number, :op_maintenance_number,
            :ref_wire, :ref_coil, :ref_tool_1, :ref_tool_2,
            :control_length, :control_stripping_left, :control_stripping_right,
            :control_crimping_height_left, :control_crimping_height_right,
            :control_traction_force_left, :control_traction_force_right, :path_image, :path_image_left, :path_image_right)",
        params! {
            "ref_of" => order_of.as_str(),
            "ref_product" => order_reference.as_str(),
            "note" => log_note.as_str(),
            "engine_name" => engine_name.as_str(),
            "user_number" => session.operator_id.as_str(),
            "app_user_id" => session.user_id.as_str(),
            "app_user_name" => session.user_name.as_deref(),
            "op_quality_number" => Some(quality_agent_id.as_str()),
            "op_maintenance_number" => Option::<&str>::None,
            "ref_wire" => identifier.ref_wire.as_str(),
            "ref_coil" => ref_coil.as_str(),
            "ref_tool_1" => ext1
                .as_ref()
                .and_then(|ext| ext.terminal.as_ref())
                .map(|s| s.as_str()),
            "ref_tool_2" => ext2
                .as_ref()
                .and_then(|ext| ext.terminal.as_ref())
                .map(|s| s.as_str()),
            "control_length" => measurements.length,
            "control_stripping_left" => measurements.stripping_left,
            "control_stripping_right" => measurements.stripping_right,
            "control_crimping_height_left" => measurements.crimp_left,
            "control_crimping_height_right" => measurements.crimp_right,
            "control_traction_force_left" => measurements.traction_left,
            "control_traction_force_right" => measurements.traction_right,
            "path_image" => legacy_path_image.as_deref(),
            "path_image_left" => photo_left.as_deref(),
            "path_image_right" => photo_right.as_deref(),
        },
    )?;

    refresh_order_status(conn, work_order_id)?;
    logging::log_info(&format!(
        "Quality test {} recorded by QA {} for {} (result: {})",
        stage_label,
        quality_agent_id,
        wire_context.as_str(),
        status_text.as_deref().unwrap_or("PENDING")
    ));
    Ok(QualityTestResultPayload {
        stage: req.test,
        result,
    })
}

struct OperatorTestLogContext {
    order_of: String,
    order_reference: String,
    ref_coil: String,
    ref_wire: String,
    ref_tool_left: Option<String>,
    ref_tool_right: Option<String>,
    machine_identifier: Option<String>,
    measurements: OperatorMeasurements,
    status_text: Option<String>,
    photo_left: Option<String>,
    photo_right: Option<String>,
}

fn apply_operator_test(
    state: &AppState,
    conn: &mut PooledConn,
    session: &SessionSnapshot,
    req: &OperatorTestRequest,
) -> Result<OperatorTestLogContext, AppError> {
    let identifier = &req.wire;
    let row = conn
        .exec_first::<Row, _, _>(
            "SELECT ow.id, ow.work_order_id, wo.app_user_id, wo.operator_id, ow.status, ow.previous_status, \
                    wo.of_id, wo.reference, wo.machine_id, ow.ref_coil, ow.length_mm, ow.ext1, ow.ext2, \
                    ow.target_quantity, ow.produced_quantity, ow.bundle_count, \
                    ow.boot_test_required, ow.boot_test_required_count, ow.boot_test_done, ow.boot_test_done_count, \
                    ow.wheel_test_required, ow.wheel_test_done, \
                    ow.final_test_required, ow.final_test_done \
             FROM order_wires ow \
             JOIN work_orders wo ON ow.work_order_id = wo.id \
             WHERE ow.work_order_id = ? AND ow.ref_wire = ? AND ow.marquage = ?",
            (
                identifier.work_order_id,
                identifier.ref_wire.as_str(),
                identifier.marquage.as_str(),
            ),
        )?
        .ok_or_else(|| AppError::Config("Wire not found for operator test update.".into()))?;

    let mut row = row;
    let wire_id: u64 = row.take("id").unwrap_or_default();
    let work_order_id: u64 = row.take("work_order_id").unwrap_or_default();
    let row_app_user: String = row
        .take::<Option<String>, _>("app_user_id")
        .unwrap_or(None)
        .unwrap_or_default();
    let row_operator: String = row
        .take::<Option<String>, _>("operator_id")
        .unwrap_or(None)
        .unwrap_or_default();
    let order_of: String = row
        .take::<Option<String>, _>("of_id")
        .unwrap_or(None)
        .unwrap_or_default();
    let order_reference: String = row
        .take::<Option<String>, _>("reference")
        .unwrap_or(None)
        .unwrap_or_default();
    let wire_context =
        summarize_wire_context(&order_of, &order_reference, identifier.ref_wire.as_str());
    let order_machine: Option<String> = row.take("machine_id");
    let ref_coil: String = row
        .take::<Option<String>, _>("ref_coil")
        .unwrap_or(None)
        .unwrap_or_default();
    let length_mm: i32 = row.take::<i64, _>("length_mm").unwrap_or(0) as i32;
    let ext1_raw: Option<String> = row.take("ext1");
    let ext2_raw: Option<String> = row.take("ext2");
    let status: String = row
        .take::<Option<String>, _>("status")
        .unwrap_or(None)
        .unwrap_or_else(|| "not_validated".into());
    let previous_status: Option<String> = row
        .take::<Option<String>, _>("previous_status")
        .unwrap_or(None)
        .filter(|value| !value.is_empty());
    let target_quantity: i32 = row.take::<i64, _>("target_quantity").unwrap_or(0) as i32;
    let produced_quantity: i32 = row.take::<i64, _>("produced_quantity").unwrap_or(0) as i32;
    let _bundle_count: i32 = row.take::<i64, _>("bundle_count").unwrap_or(1) as i32;
    let _boot_required_flag = row.take::<i64, _>("boot_test_required").unwrap_or(0) != 0;
    let boot_required_count_db: i32 =
        row.take::<i64, _>("boot_test_required_count").unwrap_or(0) as i32;
    let boot_done_flag_db = row.take::<i64, _>("boot_test_done").unwrap_or(0) != 0;
    let boot_done_count_db: i32 = row.take::<i64, _>("boot_test_done_count").unwrap_or(0) as i32;
    let wheel_required_flag = row.take::<i64, _>("wheel_test_required").unwrap_or(0) != 0;
    let wheel_done = row.take::<i64, _>("wheel_test_done").unwrap_or(0) != 0;
    let final_required_flag = row.take::<i64, _>("final_test_required").unwrap_or(0) != 0;
    let final_done = row.take::<i64, _>("final_test_done").unwrap_or(0) != 0;

    if row_app_user != session.user_id || row_operator != session.operator_id {
        return Err(AppError::Config(
            "Wire does not belong to the active session.".into(),
        ));
    }

    let ext1: Option<ApiWireExt> =
        ext1_raw.and_then(|value| serde_json::from_str::<ApiWireExt>(&value).ok());
    let ext2: Option<ApiWireExt> =
        ext2_raw.and_then(|value| serde_json::from_str::<ApiWireExt>(&value).ok());

    let spec_left = match ext1.as_ref().and_then(|ext| ext.terminal.as_ref()) {
        Some(terminal) => lookup_crimp_tool_spec(
            state,
            terminal,
            ext1.as_ref().and_then(|ext| ext.joint.as_deref()),
        )?,
        None => None,
    };
    let spec_right = match ext2.as_ref().and_then(|ext| ext.terminal.as_ref()) {
        Some(terminal) => lookup_crimp_tool_spec(
            state,
            terminal,
            ext2.as_ref().and_then(|ext| ext.joint.as_deref()),
        )?,
        None => None,
    };

    let measurements = parse_measurements_from_notes(&req.notes);
    let references = OperatorReferences {
        strip_left: ext1.as_ref().and_then(|ext| ext.stripping),
        strip_right: ext2.as_ref().and_then(|ext| ext.stripping),
        length: if length_mm > 0 {
            Some(length_mm as f64)
        } else {
            None
        },
        spec_left,
        spec_right,
    };

    let overall_passed = build_test_result(None, &measurements, &references).overall_passed;
    let status_text = match overall_passed {
        Some(true) => Some("OK".to_string()),
        Some(false) => Some("NOK".to_string()),
        None => None,
    };

    let (expected_boot_count, expect_wheel_anytime, expect_final_anytime) =
        compute_quality_requirements_for_quantity(target_quantity);

    let mut boot_required_count = expected_boot_count.max(boot_required_count_db);
    if expected_boot_count == 0 {
        boot_required_count = 0;
    }
    let mut boot_done_count = boot_done_count_db.min(boot_required_count.max(0));
    if boot_required_count == 0 {
        boot_done_count = 0;
    }
    let boot_complete = if boot_required_count > 0 {
        boot_done_count >= boot_required_count
    } else {
        true
    } && boot_done_flag_db;

    let wheel_threshold = if target_quantity > 0 {
        ((target_quantity as f64) * 0.5).ceil() as i32
    } else {
        0
    };
    let wheel_due_now = expect_wheel_anytime && produced_quantity >= wheel_threshold && !wheel_done;
    let final_due_now = expect_final_anytime
        && target_quantity > 0
        && produced_quantity >= target_quantity
        && !final_done;

    let mut new_previous_status = previous_status.clone();

    let new_status = if boot_required_count > 0 && !boot_complete {
        if status != "qc_boot" {
            new_previous_status = Some(status.clone());
        }
        "qc_boot".to_string()
    } else if wheel_due_now {
        if status != "qc_wheel" {
            new_previous_status = Some(status.clone());
        }
        "qc_wheel".to_string()
    } else if final_due_now {
        if status != "qc_final" {
            new_previous_status = Some(status.clone());
        }
        "qc_final".to_string()
    } else if produced_quantity > 0 {
        new_previous_status = None;
        "in_production".to_string()
    } else {
        new_previous_status = None;
        "validated".to_string()
    };

    let updated_wheel_required = if wheel_due_now {
        true
    } else {
        wheel_required_flag
    };
    let updated_final_required = if final_due_now {
        true
    } else {
        final_required_flag
    };

    conn.exec_drop(
        "UPDATE order_wires SET \
            boot_test_required = ?, \
            boot_test_required_count = ?, \
            boot_test_done = ?, \
            boot_test_done_count = ?, \
            operator_test_done = TRUE, \
            wheel_test_required = ?, \
            final_test_required = ?, \
            status = ?, \
            previous_status = ?, \
            updated_at = CURRENT_TIMESTAMP \
         WHERE id = ?",
        (
            boot_required_count > 0,
            boot_required_count,
            boot_complete,
            boot_done_count,
            updated_wheel_required,
            updated_final_required,
            new_status.as_str(),
            new_previous_status.as_deref(),
            wire_id,
        ),
    )?;

    let photo_front = aggregate_photo_paths(&req.notes, "front");
    let photo_back = aggregate_photo_paths(&req.notes, "back");
    let (photo_left, photo_right) = build_side_path_strings(&photo_front, &photo_back);
    let machine_identifier = order_machine
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .or_else(|| session.machine_id.clone());

    refresh_order_status(conn, work_order_id)?;
    logging::log_info(&format!(
        "Operator test recorded for {} (status: {})",
        wire_context.as_str(),
        status_text.as_deref().unwrap_or("PENDING")
    ));
    Ok(OperatorTestLogContext {
        order_of,
        order_reference,
        ref_coil,
        ref_wire: identifier.ref_wire.clone(),
        ref_tool_left: ext1
            .as_ref()
            .and_then(|ext| ext.terminal.as_ref())
            .map(|value| value.to_string()),
        ref_tool_right: ext2
            .as_ref()
            .and_then(|ext| ext.terminal.as_ref())
            .map(|value| value.to_string()),
        machine_identifier,
        measurements,
        status_text,
        photo_left,
        photo_right,
    })
}

pub(crate) fn insert_session_log(
    conn: &mut PooledConn,
    session: &SessionSnapshot,
    status: &str,
    note: &str,
    ref_of: Option<&str>,
    ref_product: Option<&str>,
    ref_wire: Option<&str>,
    ref_coil: Option<&str>,
    quantity: Option<f64>,
    label_id: Option<&str>,
    bac_id: Option<&str>,
    path_image: Option<&str>,
) -> Result<(), AppError> {
    conn.exec_drop(
        "INSERT INTO logs (
            ref_of, ref_product, quantity, status, note, engine_name, user_number,
            app_user_id, app_user_name, op_quality_number, op_maintenance_number,
            ref_wire, ref_coil, ref_tool_1, ref_tool_2,
            label_id, bac_id,
            control_length, control_stripping_left, control_stripping_right,
            control_crimping_height_left, control_crimping_height_right,
            control_traction_force_left, control_traction_force_right, path_image
        ) VALUES (:ref_of, :ref_product, :quantity, :status, :note, :engine_name, :user_number,
            :app_user_id, :app_user_name, :op_quality_number, :op_maintenance_number,
            :ref_wire, :ref_coil, :ref_tool_1, :ref_tool_2,
            :label_id, :bac_id,
            :control_length, :control_stripping_left, :control_stripping_right,
            :control_crimping_height_left, :control_crimping_height_right,
            :control_traction_force_left, :control_traction_force_right, :path_image)",
        params! {
            "ref_of" => ref_of,
            "ref_product" => ref_product,
            "quantity" => quantity,
            "status" => status,
            "note" => note,
            "engine_name" => resolve_engine_name(),
            "user_number" => Some(session.operator_id.as_str()),
            "app_user_id" => Some(session.user_id.as_str()),
            "app_user_name" => session.user_name.as_deref(),
            "op_quality_number" => Option::<&str>::None,
            "op_maintenance_number" => Option::<&str>::None,
            "ref_wire" => ref_wire,
            "ref_coil" => ref_coil,
            "ref_tool_1" => Option::<&str>::None,
            "ref_tool_2" => Option::<&str>::None,
            "label_id" => label_id,
            "bac_id" => bac_id,
            "control_length" => Option::<f64>::None,
            "control_stripping_left" => Option::<f64>::None,
            "control_stripping_right" => Option::<f64>::None,
            "control_crimping_height_left" => Option::<f64>::None,
            "control_crimping_height_right" => Option::<f64>::None,
            "control_traction_force_left" => Option::<f64>::None,
            "control_traction_force_right" => Option::<f64>::None,
            "path_image" => path_image,
        },
    )?;
    Ok(())
}

fn persist_operator_test_log(
    conn: &mut PooledConn,
    session: &SessionSnapshot,
    context: &OperatorTestLogContext,
) -> Result<(), AppError> {
    ensure_logging_tables(conn)?;

    conn.exec_drop(
        "INSERT INTO operator_control_logs (
            of_id, ref, ref_coil, machine_id, operator_id,
            control_crimping_height_left, control_crimping_height_right,
            control_traction_force_left, control_traction_force_right,
            control_stripping_left, control_stripping_right,
            control_length, path_image_left, path_image_right, status
        ) VALUES (:of_id, :ref, :ref_coil, :machine_id, :operator_id, :crimp_left, :crimp_right,
            :traction_left, :traction_right, :stripping_left, :stripping_right, :length,
            :path_left, :path_right, :status)",
        params! {
            "of_id" => context.order_of.as_str(),
            "ref" => context.ref_wire.as_str(),
            "ref_coil" => context.ref_coil.as_str(),
            "machine_id" => context.machine_identifier.as_deref(),
            "operator_id" => session.operator_id.as_str(),
            "crimp_left" => context.measurements.crimp_left,
            "crimp_right" => context.measurements.crimp_right,
            "traction_left" => context.measurements.traction_left,
            "traction_right" => context.measurements.traction_right,
            "stripping_left" => context.measurements.stripping_left,
            "stripping_right" => context.measurements.stripping_right,
            "length" => context.measurements.length,
            "path_left" => context.photo_left.as_deref(),
            "path_right" => context.photo_right.as_deref(),
            "status" => context
                .status_text
                .as_deref()
                .unwrap_or("OK"),
        },
    )?;

    let engine_name = resolve_engine_name();
    let wire_context = summarize_wire_context(
        context.order_of.as_str(),
        context.order_reference.as_str(),
        context.ref_wire.as_str(),
    );
    let legacy_path_image = combine_legacy_path_image(
        context.photo_left.as_deref(),
        context.photo_right.as_deref(),
        wire_context.as_str(),
    );

    conn.exec_drop(
        "INSERT INTO logs (
            ref_of, ref_product, quantity, status, note, engine_name, user_number,
            app_user_id, app_user_name, ref_wire, ref_coil, ref_tool_1, ref_tool_2,
            control_length, control_stripping_left, control_stripping_right,
            control_crimping_height_left, control_crimping_height_right,
            control_traction_force_left, control_traction_force_right, path_image, path_image_left, path_image_right
        ) VALUES (:ref_of, :ref_product, NULL, 'CONTROL_OP', :note, :engine_name, :user_number,
            :app_user_id, :app_user_name, :ref_wire, :ref_coil, :ref_tool_1, :ref_tool_2,
            :control_length, :control_stripping_left, :control_stripping_right,
            :control_crimping_height_left, :control_crimping_height_right,
            :control_traction_force_left, :control_traction_force_right, :path_image, :path_image_left, :path_image_right)",
        params! {
            "ref_of" => context.order_of.as_str(),
            "ref_product" => context.order_reference.as_str(),
            "note" => "Operator tests completed",
            "engine_name" => engine_name.as_str(),
            "user_number" => session.operator_id.as_str(),
            "app_user_id" => session.user_id.as_str(),
            "app_user_name" => session.user_name.as_deref(),
            "ref_wire" => context.ref_wire.as_str(),
            "ref_coil" => context.ref_coil.as_str(),
            "ref_tool_1" => context.ref_tool_left.as_deref(),
            "ref_tool_2" => context.ref_tool_right.as_deref(),
            "control_length" => context.measurements.length,
            "control_stripping_left" => context.measurements.stripping_left,
            "control_stripping_right" => context.measurements.stripping_right,
            "control_crimping_height_left" => context.measurements.crimp_left,
            "control_crimping_height_right" => context.measurements.crimp_right,
            "control_traction_force_left" => context.measurements.traction_left,
            "control_traction_force_right" => context.measurements.traction_right,
            "path_image" => legacy_path_image.as_deref(),
            "path_image_left" => context.photo_left.as_deref(),
            "path_image_right" => context.photo_right.as_deref(),
        },
    )?;

    Ok(())
}
// -------------------------------------------------------------------------------------------------
// Commands exposed to front-end
// -------------------------------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginRequest {
    user_id: String,
    user_name: String,
    role: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginResponse {
    user_id: String,
    user_name: String,
    role: String,
    csv_role: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CrimpToolSpecRequest {
    terminal: String,
    joint: Option<String>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WorkOrderInput {
    of_id: String,
    reference: String,
    quantity_total: u32,
    #[serde(default)]
    bundle_count: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WireSummary {
    id: u64,
    ref_coil: String,
    ref_wire: String,
    marquage: String,
    operator_test_done: bool,
    length_mm: i32,
    section: Option<f64>,
    color_primary: Option<String>,
    color_secondary: Option<String>,
    bundle_count: i32,
    status: String,
    previous_status: Option<String>,
    produced_quantity: i32,
    target_quantity: i32,
    progress_percent: f32,
    boot_test_done: bool,
    boot_test_required: bool,
    boot_test_required_count: i32,
    boot_test_done_count: i32,
    wheel_test_done: bool,
    wheel_test_required: bool,
    final_test_done: bool,
    final_test_required: bool,
    ext1: Option<ApiWireExt>,
    ext2: Option<ApiWireExt>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WorkOrderSummary {
    id: u64,
    of_id: String,
    reference: String,
    quantity_total: u32,
    bundle_count: u32,
    status: String,
    progress_percent: f32,
    machine_id: Option<String>,
    wires: Vec<WireSummary>,
}

fn summarize_wire_context(order_of: &str, order_reference: &str, ref_wire: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    let trimmed_of = order_of.trim();
    if !trimmed_of.is_empty() {
        parts.push(format!("OF {}", trimmed_of));
    }
    let trimmed_reference = order_reference.trim();
    if !trimmed_reference.is_empty() {
        parts.push(format!("Ref {}", trimmed_reference));
    }
    let trimmed_wire = ref_wire.trim();
    if !trimmed_wire.is_empty() {
        parts.push(format!("Wire {}", trimmed_wire));
    }
    if parts.is_empty() {
        "wire context unknown".into()
    } else {
        parts.join(" | ")
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProductionTotals {
    total_orders: usize,
    active_orders: usize,
    completed_orders: usize,
    total_wires: usize,
    validated_wires: usize,
    completed_wires: usize,
    tests_blocking: usize,
    average_progress: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProductionSnapshot {
    totals: ProductionTotals,
    orders: Vec<WorkOrderSummary>,
}

fn process_login(state: &AppState, payload: LoginRequest) -> Result<LoginResponse, String> {
    let LoginRequest {
        user_id,
        user_name,
        role,
    } = payload;

    let user_id_trimmed = user_id.trim();
    let user_name_trimmed = user_name.trim();
    logging::log_info(&format!(
        "Login attempt for user_id={} (name '{}') as role '{}'",
        user_id_trimmed,
        user_name_trimmed,
        role.trim()
    ));
    if user_id_trimmed.is_empty() || user_name_trimmed.is_empty() {
        logging::log_warn("Login rejected: missing user id or name");
        return Err("User ID and User Name are required.".into());
    }

    let normalized_role = if role.trim().is_empty() {
        "operator".to_string()
    } else {
        role.trim().to_ascii_lowercase()
    };

    let (csv_path, env_changed) =
        ensure_user_list(state, &normalized_role).map_err(|err| err.to_string())?;
    if env_changed {
        state.reload_config();
    }

    let match_row = match_user_in_csv(&csv_path, user_id_trimmed, user_name_trimmed)
        .map_err(|err| err.to_string())?;
    let (display_name, csv_role_raw) = match match_row {
        Some(r) => r,
        None => {
            logging::log_warn(&format!(
                "Login rejected for {user_id_trimmed}: credentials not found in user list"
            ));
            return Err("Invalid credentials or user not found in user list.".into());
        }
    };
    if let Some(csv_role) = csv_role_raw.as_ref() {
        if !csv_role.is_empty() && csv_role.to_ascii_lowercase() != normalized_role {
            logging::log_warn(&format!(
                "Login rejected for {user_id_trimmed}: selected role '{}' does not match CSV role '{}'",
                normalized_role,
                csv_role
            ));
            return Err("Selected role does not match the user list role.".into());
        }
    }
    {
        let mut session = state.session.lock().expect("session lock poisoned");
        session.user_id = Some(user_id_trimmed.to_string());
        session.user_name = Some(display_name.clone());
        session.role = Some(normalized_role.clone());
        session.operator_id = None;
        session.operator_name = None;
        session.machine_id = None;
        session.user_list_path = Some(csv_path);
    }

    logging::log_info(&format!(
        "Login success for user_id={} ({}) with role '{}'",
        user_id_trimmed, display_name, normalized_role
    ));

    Ok(LoginResponse {
        user_id: user_id_trimmed.to_string(),
        user_name: display_name,
        role: normalized_role,
        csv_role: csv_role_raw,
    })
}

#[tauri::command]
fn validate_login(state: State<AppState>, payload: LoginRequest) -> Result<LoginResponse, String> {
    process_login(state.inner(), payload)
}

#[tauri::command]
fn lookup_crimp_tool_spec(
    state: &AppState,
    terminal: &str,
    joint: Option<&str>,
) -> Result<Option<CrimpToolSpecResponse>, AppError> {
    let terminal_trimmed = terminal.trim();
    if terminal_trimmed.is_empty() {
        return Ok(None);
    }
    let terminal_value = terminal_trimmed.to_string();
    let joint_trimmed = joint
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());

    let pool = state.crimp_pool()?;
    let mut conn = pool.get_conn()?;
    let table = env_string("CRIMP_DB_TABLE").unwrap_or_else(|| "crimping_db".to_string());
    let columns = resolve_crimp_columns(&mut conn, &table)?;

    let query_exact = format!(
        "SELECT \
            `{ref}` AS terminal_ref, \
            `{joint}` AS joint_ref, \
            `{status}` AS status_raw, \
            `{hc}` AS hc_raw, \
            `{traction}` AS traction_raw \
         FROM `{table}` \
         WHERE `{ref}` = :terminal AND TRIM(COALESCE(`{joint}`, '')) = TRIM(:joint) \
         ORDER BY (UPPER(`{status}`) IN ('VALIDER','VALID','OK')) DESC, `{status}` DESC \
         LIMIT 1",
        ref = columns.ref_col,
        joint = columns.joint_col,
        status = columns.status_col,
        hc = columns.hc_col,
        traction = columns.traction_col,
        table = table
    );

    let params_exact = params! {
        "terminal" => &terminal_value,
        "joint" => joint_trimmed.clone().unwrap_or_default(),
    };

    let mut row_opt = conn.exec_first::<Row, _, _>(query_exact, params_exact)?;

    if row_opt.is_none() {
        let query_fallback = format!(
            "SELECT \
                `{ref}` AS terminal_ref, \
                `{joint}` AS joint_ref, \
                `{status}` AS status_raw, \
                `{hc}` AS hc_raw, \
                `{traction}` AS traction_raw \
             FROM `{table}` \
             WHERE `{ref}` = :terminal AND ( \
                 `{joint}` IS NULL OR TRIM(`{joint}`) = '' OR TRIM(`{joint}`) = '-' OR TRIM(`{joint}`) = '0' \
             ) \
             ORDER BY (UPPER(`{status}`) IN ('VALIDER','VALID','OK')) DESC, `{status}` DESC \
             LIMIT 1",
            ref = columns.ref_col,
            joint = columns.joint_col,
            status = columns.status_col,
            hc = columns.hc_col,
            traction = columns.traction_col,
            table = table
        );

        row_opt = conn.exec_first::<Row, _, _>(
            query_fallback,
            params! {
                "terminal" => &terminal_value,
            },
        )?;
    }

    Ok(row_opt.map(row_to_crimp_spec))
}

#[tauri::command]
fn fetch_crimp_tool_spec(
    state: State<AppState>,
    payload: CrimpToolSpecRequest,
) -> Result<Option<CrimpToolSpecResponse>, String> {
    lookup_crimp_tool_spec(
        state.inner(),
        payload.terminal.as_str(),
        payload.joint.as_deref(),
    )
    .map_err(|err| err.to_string())
}

fn try_cli_login() -> Result<Option<LoginResponse>, String> {
    let user_id = match env::var("CLI_LOGIN_USER_ID") {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let user_name = env::var("CLI_LOGIN_USER_NAME").map_err(|_| {
        "CLI_LOGIN_USER_NAME must be provided when CLI_LOGIN_USER_ID is set.".to_string()
    })?;
    let role = env::var("CLI_LOGIN_ROLE").unwrap_or_else(|_| "operator".into());

    if env::var("CLI_LOGIN_DEBUG").is_ok() {
        match env::var("USER_LIST_DIR") {
            Ok(value) => println!("CLI debug: USER_LIST_DIR={value}"),
            Err(_) => println!("CLI debug: USER_LIST_DIR is not set"),
        }
    }

    let state = AppState::new().map_err(|err| err.to_string())?;
    process_login(
        &state,
        LoginRequest {
            user_id,
            user_name,
            role,
        },
    )
    .map(Some)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionStartRequest {
    operator_id: String,
    machine_id: Option<String>,
    #[serde(default)]
    orders: Vec<WorkOrderInput>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionStartResponse {
    operator_id: String,
    operator_name: String,
    machine_id: Option<String>,
    orders: Vec<WorkOrderSummary>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireIdentifier {
    work_order_id: u64,
    ref_wire: String,
    marquage: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireProgressRequest {
    wire: WireIdentifier,
    produced_increment: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LabelVerificationRequest {
    wire: WireIdentifier,
    label_id: String,
    barcode: String,
    bac_id: String,
    quantity: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QualityTestRequest {
    wire: WireIdentifier,
    test: QualityTestKind,
    #[serde(default)]
    notes: HashMap<String, String>,
    quality_agent_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinalizeWireRequest {
    wire: WireIdentifier,
    quality_agent_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum QualityTestKind {
    Boot,
    Wheel,
    Final,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OperatorTestRequest {
    wire: WireIdentifier,
    #[serde(default)]
    notes: HashMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OperatorTestResultsRequest {
    wire: WireIdentifier,
}

#[derive(Default, Clone)]
struct OperatorMeasurements {
    crimp_left: Option<f64>,
    crimp_right: Option<f64>,
    traction_left: Option<f64>,
    traction_right: Option<f64>,
    stripping_left: Option<f64>,
    stripping_right: Option<f64>,
    length: Option<f64>,
}

#[derive(Default, Clone)]
struct OperatorReferences {
    strip_left: Option<f64>,
    strip_right: Option<f64>,
    length: Option<f64>,
    spec_left: Option<CrimpToolSpecResponse>,
    spec_right: Option<CrimpToolSpecResponse>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TestMeasurementVerdict {
    key: String,
    value: Option<f64>,
    nominal: Option<f64>,
    lower_bound: Option<f64>,
    upper_bound: Option<f64>,
    unit: Option<&'static str>,
    passed: Option<bool>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TestResultResponse {
    status: Option<String>,
    overall_passed: Option<bool>,
    verdicts: Vec<TestMeasurementVerdict>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct QualityTestResultPayload {
    stage: QualityTestKind,
    result: TestResultResponse,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompleteQualityTestResponse {
    snapshot: ProductionSnapshot,
    result: QualityTestResultPayload,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum HistoryFilterMode {
    All,
    Tests,
    Events,
}

impl Default for HistoryFilterMode {
    fn default() -> Self {
        HistoryFilterMode::All
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryQueryRequest {
    #[serde(default)]
    ref_of: Option<String>,
    #[serde(default)]
    ref_product: Option<String>,
    #[serde(default)]
    ref_wire: Option<String>,
    #[serde(default)]
    filter: HistoryFilterMode,
    #[serde(default)]
    cursor: Option<u64>,
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryLogEntry {
    id: u64,
    timestamp: Option<String>,
    status: String,
    note: Option<String>,
    ref_of: Option<String>,
    ref_product: Option<String>,
    ref_wire: Option<String>,
    ref_coil: Option<String>,
    quantity: Option<f64>,
    engine_name: Option<String>,
    user_number: Option<String>,
    app_user_id: Option<String>,
    app_user_name: Option<String>,
    op_quality_number: Option<String>,
    op_maintenance_number: Option<String>,
    ref_tool_1: Option<String>,
    ref_tool_2: Option<String>,
    label_id: Option<String>,
    bac_id: Option<String>,
    control_length: Option<f64>,
    control_stripping_left: Option<f64>,
    control_stripping_right: Option<f64>,
    control_crimping_height_left: Option<f64>,
    control_crimping_height_right: Option<f64>,
    control_traction_force_left: Option<f64>,
    control_traction_force_right: Option<f64>,
    path_image: Option<String>,
    path_image_left: Option<String>,
    path_image_right: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryLogPage {
    entries: Vec<HistoryLogEntry>,
    next_cursor: Option<u64>,
    has_more: bool,
}

const TEST_STATUS_SQL: &str = "status IN ('CONTROL_OP','CONTROL_QUALITY')";
const EVENT_STATUS_SQL: &str = "status IN ('START','PAUSE','STOP','END','LABEL','CHANGE_COIL','CHANGE_USER','CALL_MAINTENANCE','CALL_QUALITY','CALL_PRODUCTION','CALL_UNCONFORMITY','MAINTENANCE')";

fn normalize_filter_input(value: &Option<String>) -> Option<String> {
    value
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn query_history_logs(
    conn: &mut PooledConn,
    req: &HistoryQueryRequest,
) -> Result<HistoryLogPage, AppError> {
    let mut clauses: Vec<String> = Vec::new();
    let mut params: Vec<(String, Value)> = Vec::new();

    if let Some(cursor) = req.cursor {
        clauses.push("id < :cursor".to_string());
        params.push(("cursor".into(), Value::from(cursor)));
    }

    if let Some(ref_of) = normalize_filter_input(&req.ref_of) {
        clauses.push("ref_of = :ref_of".to_string());
        params.push(("ref_of".into(), Value::from(ref_of)));
    }

    if let Some(ref_product) = normalize_filter_input(&req.ref_product) {
        clauses.push("ref_product = :ref_product".to_string());
        params.push(("ref_product".into(), Value::from(ref_product)));
    }

    if let Some(ref_wire) = normalize_filter_input(&req.ref_wire) {
        clauses.push("ref_wire = :ref_wire".to_string());
        params.push(("ref_wire".into(), Value::from(ref_wire)));
    }

    match req.filter {
        HistoryFilterMode::All => {}
        HistoryFilterMode::Tests => clauses.push(TEST_STATUS_SQL.to_string()),
        HistoryFilterMode::Events => clauses.push(EVENT_STATUS_SQL.to_string()),
    }

    let limit = req.limit.unwrap_or(50).clamp(1, 100) as usize;
    let limit_plus_one = (limit + 1) as u64;
    params.push(("limit".into(), Value::from(limit_plus_one)));

    let mut query = String::from(
        "SELECT id, date, status, note, ref_of, ref_product, ref_wire, ref_coil, quantity, engine_name, \
         user_number, app_user_id, app_user_name, op_quality_number, op_maintenance_number, ref_tool_1, ref_tool_2, \
         label_id, bac_id, control_length, control_stripping_left, control_stripping_right, control_crimping_height_left, control_crimping_height_right, \
         control_traction_force_left, control_traction_force_right, path_image, path_image_left, path_image_right \
         FROM logs",
    );

    if !clauses.is_empty() {
        query.push_str(" WHERE ");
        query.push_str(&clauses.join(" AND "));
    }

    query.push_str(" ORDER BY date DESC, id DESC LIMIT :limit");

    let rows: Vec<Row> = conn.exec(query, params)?;
    let has_more = rows.len() > limit;
    let mut processed_rows = rows;
    if has_more {
        processed_rows.truncate(limit);
    }

    let mut next_cursor: Option<u64> = None;
    let mut entries: Vec<HistoryLogEntry> = Vec::with_capacity(processed_rows.len());

    for mut row in processed_rows {
        let id: u64 = row
            .take::<Option<u64>, _>("id")
            .unwrap_or(None)
            .unwrap_or(0);
        let timestamp_string = extract_history_timestamp(&mut row)?;
        let status: String = row
            .take::<Option<String>, _>("status")
            .unwrap_or(None)
            .unwrap_or_default();
        let note = row
            .take::<Option<String>, _>("note")
            .unwrap_or(None)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let ref_of = row.take::<Option<String>, _>("ref_of").unwrap_or(None);
        let ref_product = row.take::<Option<String>, _>("ref_product").unwrap_or(None);
        let ref_wire = row.take::<Option<String>, _>("ref_wire").unwrap_or(None);
        let ref_coil = row.take::<Option<String>, _>("ref_coil").unwrap_or(None);
        let quantity = row.take::<Option<f64>, _>("quantity").unwrap_or(None);
        let engine_name = row.take::<Option<String>, _>("engine_name").unwrap_or(None);
        let user_number = row.take::<Option<String>, _>("user_number").unwrap_or(None);
        let app_user_id = row.take::<Option<String>, _>("app_user_id").unwrap_or(None);
        let app_user_name = row
            .take::<Option<String>, _>("app_user_name")
            .unwrap_or(None);
        let op_quality_number = row
            .take::<Option<String>, _>("op_quality_number")
            .unwrap_or(None);
        let op_maintenance_number = row
            .take::<Option<String>, _>("op_maintenance_number")
            .unwrap_or(None);
        let ref_tool_1 = row.take::<Option<String>, _>("ref_tool_1").unwrap_or(None);
        let ref_tool_2 = row.take::<Option<String>, _>("ref_tool_2").unwrap_or(None);
        let label_id = row.take::<Option<String>, _>("label_id").unwrap_or(None);
        let bac_id = row.take::<Option<String>, _>("bac_id").unwrap_or(None);
        let control_length = row.take::<Option<f64>, _>("control_length").unwrap_or(None);
        let control_stripping_left = row
            .take::<Option<f64>, _>("control_stripping_left")
            .unwrap_or(None);
        let control_stripping_right = row
            .take::<Option<f64>, _>("control_stripping_right")
            .unwrap_or(None);
        let control_crimping_height_left = row
            .take::<Option<f64>, _>("control_crimping_height_left")
            .unwrap_or(None);
        let control_crimping_height_right = row
            .take::<Option<f64>, _>("control_crimping_height_right")
            .unwrap_or(None);
        let control_traction_force_left = row
            .take::<Option<f64>, _>("control_traction_force_left")
            .unwrap_or(None);
        let control_traction_force_right = row
            .take::<Option<f64>, _>("control_traction_force_right")
            .unwrap_or(None);
        let path_image = row.take::<Option<String>, _>("path_image").unwrap_or(None);
        let path_image_left = row
            .take::<Option<String>, _>("path_image_left")
            .unwrap_or(None);
        let path_image_right = row
            .take::<Option<String>, _>("path_image_right")
            .unwrap_or(None);

        if has_more {
            next_cursor = Some(id);
        }

        entries.push(HistoryLogEntry {
            id,
            timestamp: timestamp_string,
            status,
            note,
            ref_of,
            ref_product,
            ref_wire,
            ref_coil,
            quantity,
            engine_name,
            user_number,
            app_user_id,
            app_user_name,
            op_quality_number,
            op_maintenance_number,
            ref_tool_1,
            ref_tool_2,
            label_id,
            bac_id,
            control_length,
            control_stripping_left,
            control_stripping_right,
            control_crimping_height_left,
            control_crimping_height_right,
            control_traction_force_left,
            control_traction_force_right,
            path_image,
            path_image_left,
            path_image_right,
        });
    }

    Ok(HistoryLogPage {
        entries,
        next_cursor: if has_more { next_cursor } else { None },
        has_more,
    })
}

fn extract_history_timestamp(row: &mut Row) -> Result<Option<String>, AppError> {
    let value_opt = match row.take_opt::<Value, _>("date") {
        Some(Ok(value)) => value,
        Some(Err(err)) => return Err(MysqlError::from(err).into()),
        None => return Ok(None),
    };

    match value_opt {
        Value::NULL => Ok(None),
        Value::Date(year, month, day, hour, minute, second, micros) => {
            let date = NaiveDate::from_ymd_opt(year as i32, month as u32, day as u32);
            let time =
                NaiveTime::from_hms_micro_opt(hour as u32, minute as u32, second as u32, micros);

            match (date, time) {
                (Some(date), Some(time)) => {
                    let dt = NaiveDateTime::new(date, time);
                    Ok(Some(
                        DateTime::<Utc>::from_naive_utc_and_offset(dt, Utc).to_rfc3339(),
                    ))
                }
                _ => Ok(None),
            }
        }
        Value::Bytes(bytes) => {
            let raw = String::from_utf8(bytes).unwrap_or_default();
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }

            let parsed = parse_mysql_datetime(trimmed);

            Ok(parsed.map(|dt| DateTime::<Utc>::from_naive_utc_and_offset(dt, Utc).to_rfc3339()))
        }
        other => Ok(Some(format!("{other:?}"))),
    }
}

fn describe_quality_stage(kind: QualityTestKind) -> &'static str {
    match kind {
        QualityTestKind::Boot => "Boot",
        QualityTestKind::Wheel => "Wheel",
        QualityTestKind::Final => "Final",
    }
}

fn parse_measurements_from_notes(notes: &HashMap<String, String>) -> OperatorMeasurements {
    fn parse_entry(notes: &HashMap<String, String>, key: &str) -> Option<f64> {
        let raw = notes.get(key)?.trim();
        if raw.is_empty() {
            return None;
        }
        let normalized = raw.replace(',', ".");
        normalized.parse::<f64>().ok()
}

    OperatorMeasurements {
        crimp_left: parse_entry(notes, "crimp-left"),
        crimp_right: parse_entry(notes, "crimp-right"),
        traction_left: parse_entry(notes, "traction-left"),
        traction_right: parse_entry(notes, "traction-right"),
        stripping_left: parse_entry(notes, "strip-left"),
        stripping_right: parse_entry(notes, "strip-right"),
        length: parse_entry(notes, "wire-length"),
    }
}

#[derive(Default, Clone)]
struct PhotoOrientationPaths {
    left: Option<String>,
    right: Option<String>,
}

fn aggregate_photo_paths(
    notes: &HashMap<String, String>,
    orientation: &str,
) -> PhotoOrientationPaths {
    let mut result = PhotoOrientationPaths::default();
    for side in ["left", "right"] {
        let key = format!("photo-{side}-{orientation}");
        if let Some(raw) = notes.get(&key) {
            let trimmed = raw.trim();
            if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("skipped") {
                continue;
            }
            match side {
                "left" => result.left = Some(trimmed.to_string()),
                "right" => result.right = Some(trimmed.to_string()),
                _ => {}
            }
        }
    }
    result
}

fn join_side_paths(front: &Option<String>, back: &Option<String>) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    if let Some(value) = front.as_ref() {
        if !value.is_empty() {
            parts.push(value.as_str());
        }
    }
    if let Some(value) = back.as_ref() {
        if !value.is_empty() {
            parts.push(value.as_str());
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(";"))
    }
}

fn build_side_path_strings(
    front: &PhotoOrientationPaths,
    back: &PhotoOrientationPaths,
) -> (Option<String>, Option<String>) {
    let left = join_side_paths(&front.left, &back.left);
    let right = join_side_paths(&front.right, &back.right);
    (left, right)
}

fn combine_legacy_path_image(
    left: Option<&str>,
    right: Option<&str>,
    context: &str,
) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    if let Some(value) = left {
        if !value.is_empty() {
            parts.push(value);
        }
    }
    if let Some(value) = right {
        if !value.is_empty() {
            parts.push(value);
        }
    }
    if parts.is_empty() {
        return None;
    }
    let mut combined = parts.join(";");
    if combined.len() > 255 {
        combined.truncate(255);
        logging::log_warn(&format!(
            "Legacy path_image truncated for {context} to fit 255 characters"
        ));
    }
    Some(combined)
}

fn split_legacy_path_image(value: &str) -> (Option<String>, Option<String>) {
    let mut left_entries: Vec<String> = Vec::new();
    let mut right_entries: Vec<String> = Vec::new();
    let mut front_counter = 0;
    let mut back_counter = 0;

    for token in value.split(';') {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            continue;
        }
        let upper = trimmed.to_ascii_uppercase();
        let assign_to_left = match () {
            _ if upper.contains("FRONT") => {
                let target_is_left = front_counter == 0;
                front_counter += 1;
                target_is_left
            }
            _ if upper.contains("BACK") => {
                let target_is_left = back_counter == 0;
                back_counter += 1;
                target_is_left
            }
            _ => left_entries.len() <= right_entries.len(),
        };

        if assign_to_left {
            left_entries.push(trimmed.to_string());
        } else {
            right_entries.push(trimmed.to_string());
        }
    }

    let left = if left_entries.is_empty() {
        None
    } else {
        Some(left_entries.join(";"))
    };
    let right = if right_entries.is_empty() {
        None
    } else {
        Some(right_entries.join(";"))
    };
    (left, right)
}

fn build_test_result(
    status: Option<String>,
    measurements: &OperatorMeasurements,
    references: &OperatorReferences,
) -> TestResultResponse {
    let mut verdicts: Vec<TestMeasurementVerdict> = Vec::new();

    let push_crimp = |verdicts: &mut Vec<TestMeasurementVerdict>,
                      key: &str,
                      value: Option<f64>,
                      spec: &Option<CrimpToolSpecResponse>| {
        let (lower, upper, nominal) = match spec {
            Some(spec) => (spec.hc_min, spec.hc_max, spec.hc_nominal),
            None => (None, None, None),
        };
        let passed = match (value, lower, upper) {
            (Some(v), Some(lo), Some(hi)) => Some(v >= lo && v <= hi),
            _ => None,
        };
        verdicts.push(TestMeasurementVerdict {
            key: key.to_string(),
            value,
            nominal,
            lower_bound: lower,
            upper_bound: upper,
            unit: Some("mm"),
            passed,
        });
    };

    push_crimp(
        &mut verdicts,
        "crimp-left",
        measurements.crimp_left,
        &references.spec_left,
    );
    push_crimp(
        &mut verdicts,
        "crimp-right",
        measurements.crimp_right,
        &references.spec_right,
    );

    let push_traction = |verdicts: &mut Vec<TestMeasurementVerdict>,
                         key: &str,
                         value: Option<f64>,
                         spec: &Option<CrimpToolSpecResponse>| {
        let nominal = spec.as_ref().and_then(|s| s.traction_nominal);
        let passed = match (value, nominal) {
            (Some(v), Some(min)) => Some(v >= min),
            _ => None,
        };
        verdicts.push(TestMeasurementVerdict {
            key: key.to_string(),
            value,
            nominal,
            lower_bound: nominal,
            upper_bound: None,
            unit: Some("N"),
            passed,
        });
    };

    push_traction(
        &mut verdicts,
        "traction-left",
        measurements.traction_left,
        &references.spec_left,
    );
    push_traction(
        &mut verdicts,
        "traction-right",
        measurements.traction_right,
        &references.spec_right,
    );

    let push_strip = |verdicts: &mut Vec<TestMeasurementVerdict>,
                      key: &str,
                      value: Option<f64>,
                      reference: Option<f64>| {
        let lower = reference.map(|r| (r - 0.5).max(0.0));
        let upper = reference.map(|r| r + 0.5);
        let passed = match (value, lower, upper) {
            (Some(v), Some(lo), Some(hi)) => Some(v >= lo && v <= hi),
            _ => None,
        };
        verdicts.push(TestMeasurementVerdict {
            key: key.to_string(),
            value,
            nominal: reference,
            lower_bound: lower,
            upper_bound: upper,
            unit: Some("mm"),
            passed,
        });
    };

    push_strip(
        &mut verdicts,
        "strip-left",
        measurements.stripping_left,
        references.strip_left,
    );
    push_strip(
        &mut verdicts,
        "strip-right",
        measurements.stripping_right,
        references.strip_right,
    );

    let (length_lower, length_upper) = if let Some(nominal) = references.length {
        (Some((nominal - 5.0).max(0.0)), Some(nominal + 5.0))
    } else {
        (None, None)
    };
    let length_passed = match (measurements.length, length_lower, length_upper) {
        (Some(value), Some(lo), Some(hi)) => Some(value >= lo && value <= hi),
        _ => None,
    };
    verdicts.push(TestMeasurementVerdict {
        key: "length".to_string(),
        value: measurements.length,
        nominal: references.length,
        lower_bound: length_lower,
        upper_bound: length_upper,
        unit: Some("mm"),
        passed: length_passed,
    });

    let mut overall: Option<bool> = None;
    for verdict in &verdicts {
        if let Some(passed) = verdict.passed {
            overall = Some(overall.unwrap_or(true) && passed);
        }
    }

    TestResultResponse {
        status,
        overall_passed: overall,
        verdicts,
    }
}

#[tauri::command]
fn start_session(
    state: State<AppState>,
    payload: SessionStartRequest,
) -> Result<SessionStartResponse, String> {
    if payload.operator_id.trim().is_empty() {
        logging::log_warn("Session start rejected: missing operator id");
        return Err("Operator ID is required.".into());
    }

    let (user_id, role, csv_path_opt) = {
        let session = state.session.lock().expect("session lock poisoned");
        (
            session.user_id.clone(),
            session.role.clone(),
            session.user_list_path.clone(),
        )
    };
    let user_id =
        user_id.ok_or_else(|| "A user must be logged in before starting a session.".to_string())?;
    let role = role.unwrap_or_else(|| "operator".to_string());
    let csv_path = if let Some(path) = csv_path_opt {
        path
    } else {
        let (path, env_changed) = ensure_user_list(&state, &role).map_err(|err| err.to_string())?;
        if env_changed {
            state.reload_config();
        }
        {
            let mut session = state.session.lock().expect("session lock poisoned");
            session.user_list_path = Some(path.clone());
        }
        path
    };

    let operator_id_trimmed = payload.operator_id.trim().to_string();

    let requested_order_count = payload.orders.len();
    let requested_quantity: u32 = payload
        .orders
        .iter()
        .map(|order| order.quantity_total)
        .sum();
    let requested_bundles: u32 = payload
        .orders
        .iter()
        .map(|order| {
            if order.bundle_count == 0 {
                1
            } else {
                order.bundle_count
            }
        })
        .sum();

    logging::log_info(&format!(
        "Session start requested by user {} for operator {} (machine {:?}): {requested_order_count} order(s), {requested_quantity} unit target(s), {requested_bundles} bundle(s)",
        user_id,
        operator_id_trimmed,
        payload
            .machine_id
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
    ));

    let operator_info = find_operator_name(&csv_path, operator_id_trimmed.as_str())
        .map_err(|err| err.to_string())?;
    let (operator_name, _) = operator_info
        .filter(|(name, _)| !name.is_empty())
        .ok_or_else(|| "Operator ID not found in user list.".to_string())?;

    let host = resolve_engine_name();

    let machine_id_clean = payload
        .machine_id
        .as_ref()
        .map(|m| m.trim().to_string())
        .filter(|s| !s.is_empty());

    let pool = state.app_pool().map_err(|err| err.to_string())?;
    let mut conn = pool.get_conn().map_err(|err| err.to_string())?;
    ensure_user_session_tables(&mut conn).map_err(|err| err.to_string())?;
    ensure_workflow_tables(&mut conn).map_err(|err| err.to_string())?;
    clear_sessions_for_host(&mut conn, &host).map_err(|err| err.to_string())?;
    if is_user_operator_active(&mut conn, &user_id, operator_id_trimmed.as_str(), &host)
        .map_err(|err| err.to_string())?
    {
        logging::log_warn(&format!(
            "Operator {} already active for user {}; rejecting new session",
            operator_id_trimmed, user_id
        ));
        return Err(
            "This operator is already active for the current user on another workstation. Please contact admin."
                .into(),
        );
    }
    upsert_user_session(&mut conn, &user_id, operator_id_trimmed.as_str(), &host)
        .map_err(|err| err.to_string())?;

    let active_order_keys: HashSet<String> = payload
        .orders
        .iter()
        .map(|order| canonicalize_order_key(order.of_id.as_str(), order.reference.as_str()))
        .collect();

    if !payload.orders.is_empty() {
        upsert_orders_and_wires(
            state.inner(),
            &mut conn,
            &user_id,
            operator_id_trimmed.as_str(),
            machine_id_clean.as_deref(),
            &payload.orders,
            &role,
        )
        .map_err(|err| err.to_string())?;
    }

    let orders_snapshot = load_orders_for_session(
        &mut conn,
        &user_id,
        operator_id_trimmed.as_str(),
        Some(&active_order_keys),
    )
    .map_err(|err| err.to_string())?;

    {
        let mut session = state.session.lock().expect("session lock poisoned");
        session.operator_id = Some(operator_id_trimmed.clone());
        session.operator_name = Some(operator_name.clone());
        session.machine_id = machine_id_clean.clone();
        session.active_orders = active_order_keys;
    }

    let order_count = orders_snapshot.len();
    let wire_count: usize = orders_snapshot.iter().map(|order| order.wires.len()).sum();

    logging::log_info(&format!(
        "Session started for operator {} ({operator_name}) on machine {:?}: loaded {order_count} order(s) with {wire_count} wire(s)",
        operator_id_trimmed,
        machine_id_clean
    ));

    Ok(SessionStartResponse {
        operator_id: operator_id_trimmed,
        operator_name,
        machine_id: machine_id_clean,
        orders: orders_snapshot,
    })
}
#[tauri::command]
fn logout(state: State<AppState>) -> Result<(), String> {
    let app_state = state.inner();
    logging::log_info("Logout requested by current session");
    if let Ok(snapshot) = current_session_snapshot(app_state) {
        let pool = app_state.app_pool().map_err(|err| err.to_string())?;
        let mut conn = pool.get_conn().map_err(|err| err.to_string())?;
        ensure_logging_tables(&mut conn).map_err(|err| err.to_string())?;
        insert_session_log(
            &mut conn,
            &snapshot,
            "CHANGE_USER",
            &format!("User session ended for operator {}", snapshot.operator_id),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .map_err(|err| err.to_string())?;
    }

    cleanup_active_session(app_state);
    {
        let mut session = app_state.session.lock().expect("session lock poisoned");
        *session = SessionState::default();
    }
    logging::log_info("Session cleared and user logged out");
    Ok(())
}
#[tauri::command]
fn perform_preflight(state: State<AppState>) -> Result<PreflightReport, String> {
    let role = {
        let session = state.session.lock().expect("session lock poisoned");
        session.role.clone().unwrap_or_else(|| "operator".into())
    };

    let app_db_status = match state.app_pool() {
        Ok(pool) => match pool.get_conn() {
            Ok(mut conn) => {
                if let Err(err) = conn.query_drop("SELECT 1") {
                    CheckStatus::error(format!("APP DB probe failed: {err}"))
                } else if let Err(err) = ensure_user_session_tables(&mut conn) {
                    CheckStatus::error(format!("APP DB init failed: {err}"))
                } else {
                    CheckStatus::ok("Connected to APP database.")
                }
            }
            Err(err) => CheckStatus::error(format!("APP DB connection failed: {err}")),
        },
        Err(AppError::Config(msg)) => CheckStatus::error(format!("APP DB not configured: {msg}")),
        Err(err) => CheckStatus::error(format!("APP DB error: {err}")),
    };

    let crimp_db_status = match state.crimp_pool() {
        Ok(pool) => match pool.get_conn() {
            Ok(mut conn) => {
                if let Err(err) = conn.query_drop("SELECT 1") {
                    CheckStatus::error(format!("CRIMP DB probe failed: {err}"))
                } else {
                    CheckStatus::ok("Connected to CRIMP database.")
                }
            }
            Err(err) => CheckStatus::error(format!("CRIMP DB connection failed: {err}")),
        },
        Err(AppError::Config(msg)) => CheckStatus::error(format!("CRIMP DB not configured: {msg}")),
        Err(err) => CheckStatus::error(format!("CRIMP DB error: {err}")),
    };

    let config_snapshot = state.config.read().expect("config lock poisoned").clone();
    let shared_folder_status = match config_snapshot.shared_folder.clone() {
        Some(path) => {
            if let Err(err) = fs::create_dir_all(&path) {
                CheckStatus::error(format!(
                    "Shared folder {} not accessible: {err}",
                    path.display()
                ))
            } else {
                CheckStatus::ok(format!("Shared folder available at {}", path.display()))
            }
        }
        None => CheckStatus::error("SHARED_FOLDER (or NETWORK_PHOTO_SHARE) not configured."),
    };

    let microscope_status = match config_snapshot.microscope_photo_dir.clone() {
        Some(path) => {
            if path.exists() {
                CheckStatus::ok(format!("Microscope folder found at {}", path.display()))
            } else {
                CheckStatus::error(format!("Microscope folder not found at {}", path.display()))
            }
        }
        None => CheckStatus::error("MICROSCOPE_PHOTO_DIR not configured."),
    };

    let api_status = match resolve_api_base_url(&config_snapshot, &role) {
        Some(url) => match state
            .http_client
            .get(url.clone())
            .timeout(Duration::from_secs(4))
            .send()
        {
            Ok(resp) if resp.status().is_server_error() => {
                CheckStatus::error(format!("API responded with error: HTTP {}", resp.status()))
            }
            Ok(_) => CheckStatus::ok("API reachable."),
            Err(err) => CheckStatus::error(format!("API not reachable: {err}")),
        },
        None => CheckStatus::error("API_BASE_URL not configured."),
    };

    Ok(PreflightReport {
        app_db: app_db_status,
        crimp_db: crimp_db_status,
        shared_folder: shared_folder_status,
        microscope_folder: microscope_status,
        api: api_status,
    })
}
// -------------------------------------------------------------------------------------------------
// Existing demo commands (dashboard demo + greet)
// -------------------------------------------------------------------------------------------------

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}! The Tauri backend is online.")
}

#[tauri::command]
fn get_dashboard_snapshot(state: State<AppState>) -> Result<ProductionSnapshot, String> {
    build_production_snapshot(state.inner()).map_err(|err| err.to_string())
}

#[tauri::command]
fn validate_wire(
    state: State<AppState>,
    payload: WireIdentifier,
) -> Result<ProductionSnapshot, String> {
    let state_ref = state.inner();
    let session_snapshot = current_session_snapshot(state_ref).map_err(|err| err.to_string())?;
    let pool = state_ref.app_pool().map_err(|err| err.to_string())?;
    let mut conn = pool.get_conn().map_err(|err| err.to_string())?;
    ensure_workflow_tables(&mut conn).map_err(|err| err.to_string())?;
    ensure_logging_tables(&mut conn).map_err(|err| err.to_string())?;
    apply_wire_validation(&mut conn, &session_snapshot, &payload).map_err(|err| err.to_string())?;
    build_production_snapshot(state_ref).map_err(|err| err.to_string())
}

#[tauri::command]
fn pause_wire(
    state: State<AppState>,
    payload: WireIdentifier,
) -> Result<ProductionSnapshot, String> {
    let state_ref = state.inner();
    let session_snapshot = current_session_snapshot(state_ref).map_err(|err| err.to_string())?;
    let pool = state_ref.app_pool().map_err(|err| err.to_string())?;
    let mut conn = pool.get_conn().map_err(|err| err.to_string())?;
    ensure_workflow_tables(&mut conn).map_err(|err| err.to_string())?;
    ensure_logging_tables(&mut conn).map_err(|err| err.to_string())?;
    apply_pause_wire(&mut conn, &session_snapshot, &payload).map_err(|err| err.to_string())?;
    build_production_snapshot(state_ref).map_err(|err| err.to_string())
}

#[tauri::command]
fn resume_wire(
    state: State<AppState>,
    payload: WireIdentifier,
) -> Result<ProductionSnapshot, String> {
    let state_ref = state.inner();
    let session_snapshot = current_session_snapshot(state_ref).map_err(|err| err.to_string())?;
    let pool = state_ref.app_pool().map_err(|err| err.to_string())?;
    let mut conn = pool.get_conn().map_err(|err| err.to_string())?;
    ensure_workflow_tables(&mut conn).map_err(|err| err.to_string())?;
    apply_resume_wire(&mut conn, &session_snapshot, &payload).map_err(|err| err.to_string())?;
    build_production_snapshot(state_ref).map_err(|err| err.to_string())
}

#[tauri::command]
fn stop_wire(
    state: State<AppState>,
    payload: WireIdentifier,
) -> Result<ProductionSnapshot, String> {
    let state_ref = state.inner();
    let session_snapshot = current_session_snapshot(state_ref).map_err(|err| err.to_string())?;
    let pool = state_ref.app_pool().map_err(|err| err.to_string())?;
    let mut conn = pool.get_conn().map_err(|err| err.to_string())?;
    ensure_workflow_tables(&mut conn).map_err(|err| err.to_string())?;
    ensure_logging_tables(&mut conn).map_err(|err| err.to_string())?;
    apply_stop_wire(&mut conn, &session_snapshot, &payload).map_err(|err| err.to_string())?;
    build_production_snapshot(state_ref).map_err(|err| err.to_string())
}

#[tauri::command]
fn verify_user_id(
    state: State<AppState>,
    user_id: String,
) -> Result<VerifyUserResponse, String> {
    let state_ref = state.inner();
    let (csv_path, _) = ensure_user_list(state_ref, "operator").map_err(|err| err.to_string())?;
    
    let result = verify_user_id_only(&csv_path, &user_id).map_err(|err| err.to_string())?;
    
    match result {
        Some((user_name, is_admin)) => Ok(VerifyUserResponse {
            valid: true,
            user_name: Some(user_name),
            is_admin,
            message: "User verified".to_string(),
        }),
        None => Ok(VerifyUserResponse {
            valid: false,
            user_name: None,
            is_admin: false,
            message: "User ID not found".to_string(),
        }),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnlockWireRequest {
    wire: WireIdentifier,
    user_id: String,
    action: String, // "restart" or "continue"
}

#[tauri::command]
fn unlock_wire(
    state: State<AppState>,
    payload: UnlockWireRequest,
) -> Result<ProductionSnapshot, String> {
    let state_ref = state.inner();
    let session_snapshot = current_session_snapshot(state_ref).map_err(|err| err.to_string())?;
    let pool = state_ref.app_pool().map_err(|err| err.to_string())?;
    let mut conn = pool.get_conn().map_err(|err| err.to_string())?;
    ensure_workflow_tables(&mut conn).map_err(|err| err.to_string())?;
    ensure_logging_tables(&mut conn).map_err(|err| err.to_string())?;

    // 1. Verify user is authorized (admin or original stopper)
    let (csv_path, _) = ensure_user_list(state_ref, "operator").map_err(|err| err.to_string())?;
    let user_valid = verify_user_id_only(&csv_path, &payload.user_id).map_err(|err| err.to_string())?;
    
    let (user_name, is_admin) = match user_valid {
        Some(u) => u,
        None => return Err("User not authorized".to_string()),
    };

    // 2. Get wire details to check stopped_by_user
    let row = conn.exec_first::<Row, _, _>(
        "SELECT id, work_order_id, status, stopped_by_user FROM order_wires 
         WHERE work_order_id = ? AND ref_wire = ? AND marquage = ?",
        (payload.wire.work_order_id, payload.wire.ref_wire.as_str(), payload.wire.marquage.as_str()),
    ).map_err(|err| err.to_string())?
    .ok_or("Wire not found")?;

    let wire_id: u64 = row.get("id").unwrap();
    let work_order_id: u64 = row.get("work_order_id").unwrap();
    let status: String = row.get("status").unwrap_or_default();
    let stopped_by: Option<String> = row.get("stopped_by_user").unwrap_or(None);

    if status != "stopped" {
        return Err("Wire is not stopped".to_string());
    }

    // Check authorization: Must be admin OR the user who stopped it
    let is_stopper = stopped_by.as_deref() == Some(&payload.user_id);
    if !is_admin && !is_stopper {
        return Err("Unauthorized: Only an admin or the user who stopped the wire can unlock it.".to_string());
    }

    // 3. Apply Action
    if payload.action == "restart" {
        // Reset produced quantity to 0, status to validated (ready for production)
        // Also resets operator test flag implicitly by status change if needed, logic depends on app flow
        conn.exec_drop(
            "UPDATE order_wires SET 
             status = 'validated', 
             produced_quantity = 0,
             operator_test_done = 0,
             stopped_by_user = NULL,
             updated_at = CURRENT_TIMESTAMP 
             WHERE id = ?",
            (wire_id,),
        ).map_err(|err| err.to_string())?;
        
        // Log restart
         insert_session_log(
            &mut conn,
            &session_snapshot,
            "RESTART",
            &format!("Production restarted by {} (Unlock)", user_name),
            None, None, Some(payload.wire.ref_wire.as_str()), None, None, None, None, None
        ).map_err(|err| err.to_string())?;

    } else if payload.action == "continue" {
        // Restore previous status
        // Ensure previous_status is valid, otherwise fallback to 'validated'
        let prev_status: Option<String> = row.get("previous_status").unwrap_or(None);
        let safe_status = prev_status
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "validated".to_string());

        conn.exec_drop(
            "UPDATE order_wires SET 
             status = ?,
             stopped_by_user = NULL,
             updated_at = CURRENT_TIMESTAMP 
             WHERE id = ?",
            (safe_status, wire_id),
        ).map_err(|err| err.to_string())?;

        // Log continue
         insert_session_log(
            &mut conn,
            &session_snapshot,
            "RESUME",
            &format!("Production resumed by {} (Unlock)", user_name),
             None, None, Some(payload.wire.ref_wire.as_str()), None, None, None, None, None
        ).map_err(|err| err.to_string())?;
    } else {
        return Err("Invalid action".to_string());
    }

    refresh_order_status(&mut conn, work_order_id).map_err(|err| err.to_string())?;
    build_production_snapshot(state_ref).map_err(|err| err.to_string())
}

#[tauri::command]
fn record_wire_progress(
    state: State<AppState>,
    payload: WireProgressRequest,
) -> Result<ProductionSnapshot, String> {
    let state_ref = state.inner();
    let session_snapshot = current_session_snapshot(state_ref).map_err(|err| err.to_string())?;
    let pool = state_ref.app_pool().map_err(|err| err.to_string())?;
    let mut conn = pool.get_conn().map_err(|err| err.to_string())?;
    ensure_workflow_tables(&mut conn).map_err(|err| err.to_string())?;
    ensure_logging_tables(&mut conn).map_err(|err| err.to_string())?;
    apply_wire_progress(&mut conn, &session_snapshot, &payload).map_err(|err| err.to_string())?;
    build_production_snapshot(state_ref).map_err(|err| err.to_string())
}

#[tauri::command]
fn finalize_wire_production(
    state: State<AppState>,
    payload: FinalizeWireRequest,
) -> Result<ProductionSnapshot, String> {
    let state_ref = state.inner();
    let session_snapshot = current_session_snapshot(state_ref).map_err(|err| err.to_string())?;
    let pool = state_ref.app_pool().map_err(|err| err.to_string())?;
    let mut conn = pool.get_conn().map_err(|err| err.to_string())?;
    ensure_workflow_tables(&mut conn).map_err(|err| err.to_string())?;
    ensure_logging_tables(&mut conn).map_err(|err| err.to_string())?;
    apply_wire_finalization(&mut conn, &session_snapshot, &payload)
        .map_err(|err| err.to_string())?;
    build_production_snapshot(state_ref).map_err(|err| err.to_string())
}

#[tauri::command]
fn verify_bundle_label(
    state: State<AppState>,
    payload: LabelVerificationRequest,
) -> Result<(), String> {
    let state_ref = state.inner();
    let session_snapshot = current_session_snapshot(state_ref).map_err(|err| err.to_string())?;

    let label_id_clean = payload.label_id.trim().to_string();
    if label_id_clean.is_empty() {
        return Err("Label identifier is required before continuing.".into());
    }

    let barcode_clean = payload.barcode.trim().to_string();
    if barcode_clean.is_empty() {
        return Err("Scan the printed barcode before continuing.".into());
    }

    let bac_clean = payload.bac_id.trim().to_string();
    if bac_clean.is_empty() {
        return Err("Scan the final storage bin (bac) before continuing.".into());
    }

    let pool = state_ref.app_pool().map_err(|err| err.to_string())?;
    let mut conn = pool.get_conn().map_err(|err| err.to_string())?;
    ensure_workflow_tables(&mut conn).map_err(|err| err.to_string())?;
    ensure_logging_tables(&mut conn).map_err(|err| err.to_string())?;

    let identifier = payload.wire;
    let row = conn
        .exec_first::<Row, _, _>(
            "SELECT wo.app_user_id, wo.operator_id, wo.of_id, wo.reference, ow.ref_coil, ow.marquage \
             FROM order_wires ow \
             JOIN work_orders wo ON ow.work_order_id = wo.id \
             WHERE ow.work_order_id = ? AND ow.ref_wire = ? AND ow.marquage = ?",
            (
                identifier.work_order_id,
                identifier.ref_wire.as_str(),
                identifier.marquage.as_str(),
            ),
        )
        .map_err(|err| err.to_string())?
        .ok_or_else(|| AppError::Config("Wire not found for label verification.".into()))
        .map_err(|err| err.to_string())?;

    let mut row = row;
    let row_app_user: String = row
        .take::<Option<String>, _>("app_user_id")
        .unwrap_or(None)
        .unwrap_or_default();
    let row_operator: String = row
        .take::<Option<String>, _>("operator_id")
        .unwrap_or(None)
        .unwrap_or_default();

    if row_app_user != session_snapshot.user_id || row_operator != session_snapshot.operator_id {
        return Err("Wire does not belong to the active session.".into());
    }

    let order_of: String = row
        .take::<Option<String>, _>("of_id")
        .unwrap_or(None)
        .unwrap_or_default();
    let order_reference: String = row
        .take::<Option<String>, _>("reference")
        .unwrap_or(None)
        .unwrap_or_default();
    let ref_coil: String = row
        .take::<Option<String>, _>("ref_coil")
        .unwrap_or(None)
        .unwrap_or_default();
    let row_marquage: String = row
        .take::<Option<String>, _>("marquage")
        .unwrap_or(None)
        .unwrap_or_else(|| identifier.marquage.clone());
    let wire_context =
        summarize_wire_context(&order_of, &order_reference, identifier.ref_wire.as_str());
    let expected_barcode = {
        let from_db = row_marquage.trim();
        if !from_db.is_empty() {
            from_db.to_string()
        } else {
            let identifier_marquage = identifier.marquage.trim();
            if !identifier_marquage.is_empty() {
                identifier_marquage.to_string()
            } else {
                let identifier_ref = identifier.ref_wire.trim();
                if !identifier_ref.is_empty() {
                    identifier_ref.to_string()
                } else {
                    String::new()
                }
            }
        }
    };
    if !expected_barcode.is_empty()
        && !barcode_clean.eq_ignore_ascii_case(expected_barcode.as_str())
    {
        return Err(
            "Scanned barcode does not match the wire marking. Reprint the label and retry.".into(),
        );
    }

    let quantity_value = payload.quantity.max(0) as f64;
    let quantity_option = if quantity_value > 0.0 {
        Some(quantity_value)
    } else {
        None
    };

    let note = format!(
        "Label {} verified (barcode {}) placed in bac {}",
        label_id_clean, barcode_clean, bac_clean
    );

    let ref_of_opt = if order_of.trim().is_empty() {
        None
    } else {
        Some(order_of.as_str())
    };
    let ref_product_opt = if order_reference.trim().is_empty() {
        None
    } else {
        Some(order_reference.as_str())
    };
    let ref_coil_opt = if ref_coil.trim().is_empty() {
        None
    } else {
        Some(ref_coil.as_str())
    };

    insert_session_log(
        &mut conn,
        &session_snapshot,
        "LABEL",
        &note,
        ref_of_opt,
        ref_product_opt,
        Some(identifier.ref_wire.as_str()),
        ref_coil_opt,
        quantity_option,
        Some(label_id_clean.as_str()),
        Some(bac_clean.as_str()),
        None,
    )
    .map_err(|err| err.to_string())?;

    logging::log_info(&format!(
        "Label {} verified for {} and placed in bac {}",
        label_id_clean,
        wire_context.as_str(),
        bac_clean
    ));

    Ok(())
}

fn sanitize_file_token(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    let mut sanitized: String = trimmed
        .chars()
        .map(|ch| match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' => ch,
            _ => '_',
        })
        .collect();
    if sanitized.trim_matches(['_', '-'].as_ref()).is_empty() {
        sanitized = fallback.to_string();
    }
    const TOKEN_LIMIT: usize = 24;
    if sanitized.len() > TOKEN_LIMIT {
        sanitized.truncate(TOKEN_LIMIT);
    }
    sanitized
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MicroscopePhotoSaveRequest {
    source_path: String,
    orientation: String,
    #[allow(dead_code)]
    side: Option<String>,
    of_id: String,
    reference: String,
    ref_wire: String,
    #[allow(dead_code)]
    marquage: String,
    #[allow(dead_code)]
    machine_id: Option<String>,
    #[allow(dead_code)]
    operator_id: Option<String>,
    quality_agent_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DepartmentCallRequest {
    department: String,
}

#[tauri::command]
fn save_microscope_photo(
    state: State<AppState>,
    payload: MicroscopePhotoSaveRequest,
) -> Result<String, String> {
    let result: Result<String, AppError> = (|| {
        let MicroscopePhotoSaveRequest {
            source_path,
            orientation,
            side: _,
            of_id,
            reference,
            ref_wire,
            marquage: _,
            machine_id: _,
            operator_id: _,
            quality_agent_id,
        } = payload;

        let config_snapshot = state.config.read().expect("config lock poisoned").clone();
        let shared_folder = config_snapshot.shared_folder.ok_or_else(|| {
            AppError::Config("SHARED_FOLDER not configured for microscope uploads.".into())
        })?;

        let session_snapshot = current_session_snapshot(state.inner())?;
        let operator_session_id = session_snapshot.operator_id;

        let owner_kind = quality_agent_id
            .as_ref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
        let owner_segment = if owner_kind {
            SHARED_QUALITY_DIR
        } else {
            SHARED_OPERATOR_DIR
        };
        let owner_prefix = if owner_kind { "QA" } else { "OP" };
        let images_root = shared_folder.join(SHARED_IMAGES_DIR);
        let dest_dir = images_root.join(owner_segment);
        fs::create_dir_all(&dest_dir)?;

        let legacy_dir = shared_folder.join(SHARED_MICROSCOPE_DIR);
        fs::create_dir_all(&legacy_dir)?;

        let source_path = PathBuf::from(source_path.trim());
        if !source_path.exists() {
            return Err(AppError::Config(
                "Selected microscope photo was not found on disk.".into(),
            ));
        }

        let orientation_token = if orientation.eq_ignore_ascii_case("back") {
            "BACK"
        } else {
            "FRONT"
        };

        let sanitized_of = sanitize_file_token(of_id.as_str(), "OF");
        let primary_reference = sanitize_file_token(reference.as_str(), "REF");
        let sanitized_wire = sanitize_file_token(ref_wire.as_str(), "WIRE");
        let file_name = format!(
            "{owner_prefix}_{sanitized_of}_{primary_reference}_{sanitized_wire}_{orientation_token}.jpg"
        );
        let relative_path = Path::new(SHARED_IMAGES_DIR)
            .join(owner_segment)
            .join(&file_name);
        let candidate = shared_folder.join(&relative_path);
        if candidate.exists() {
            fs::remove_file(&candidate)?;
        }

        fs::copy(&source_path, &candidate)?;

        let legacy_path = legacy_dir.join(&file_name);
        if legacy_path.exists() {
            fs::remove_file(&legacy_path)?;
        }
        if legacy_path != candidate {
            if let Err(link_err) = fs::hard_link(&candidate, &legacy_path) {
                if let Err(copy_err) = fs::copy(&candidate, &legacy_path) {
                    logging::log_warn(&format!(
                        "Unable to mirror microscope photo for legacy consumers: {link_err}; fallback copy error: {copy_err}"
                    ));
                }
            }
        }

        let relative_string = relative_path.to_string_lossy().replace('\\', "/");
        logging::log_info(&format!(
            "Microscope photo saved for {owner_segment} ({}) at {relative_string}",
            operator_session_id
        ));
        Ok(relative_string)
    })();

    result.map_err(|err| {
        logging::log_error(&format!("Microscope photo save failed: {err}"));
        err.to_string()
    })
}

#[tauri::command]
fn trigger_department_call(
    state: State<AppState>,
    payload: DepartmentCallRequest,
) -> Result<(), String> {
    let result: Result<(), AppError> = (|| {
        let DepartmentCallRequest { department } = payload;
        let normalized = department.trim().to_ascii_lowercase();
        let (env_key, label) = match normalized.as_str() {
            "maintenance" => ("URL_CALL_MAINTENANCE", "Maintenance"),
            "quality" | "qualite" => ("URL_CALL_QUALITE", "Quality"),
            "production" => ("URL_CALL_PRODUCTION", "Production"),
            "non-conformity" | "non_conformity" | "nonconformity" | "non conformite"
            | "non-conformite" => ("URL_CALL_NON_CONFORMITE", "Non-Conformity"),
            other => {
                return Err(AppError::Config(format!(
                    "Unsupported department call '{other}'."
                )));
            }
        };

        let url = env_string(env_key).ok_or_else(|| {
            AppError::Config(format!(
                "{env_key} is not configured. Update the environment to enable {label} calls."
            ))
        })?;

        let response = state
            .http_client
            .get(url.clone())
            .timeout(Duration::from_secs(4))
            .send()?;

        if !response.status().is_success() {
            return Err(AppError::Network(format!(
                "{label} call failed with HTTP {}",
                response.status()
            )));
        }

        logging::log_info(&format!("{label} call dispatched to {url}"));
        Ok(())
    })();

    result.map_err(|err| {
        logging::log_error(&format!("Department call error: {err}"));
        err.to_string()
    })
}

#[tauri::command]
fn complete_quality_test(
    state: State<AppState>,
    payload: QualityTestRequest,
) -> Result<CompleteQualityTestResponse, String> {
    let state_ref = state.inner();
    let session_snapshot = current_session_snapshot(state_ref).map_err(|err| err.to_string())?;
    let pool = state_ref.app_pool().map_err(|err| err.to_string())?;
    let mut conn = pool.get_conn().map_err(|err| err.to_string())?;
    ensure_workflow_tables(&mut conn).map_err(|err| err.to_string())?;
    let outcome = apply_quality_test(state_ref, &mut conn, &session_snapshot, &payload)
        .map_err(|err| err.to_string())?;
    let snapshot = build_production_snapshot(state_ref).map_err(|err| err.to_string())?;
    Ok(CompleteQualityTestResponse {
        snapshot,
        result: outcome,
    })
}

#[tauri::command]
fn complete_operator_test(
    state: State<AppState>,
    payload: OperatorTestRequest,
) -> Result<ProductionSnapshot, String> {
    let state_ref = state.inner();
    let session_snapshot = current_session_snapshot(state_ref).map_err(|err| err.to_string())?;
    let pool = state_ref.app_pool().map_err(|err| err.to_string())?;
    let mut conn = pool.get_conn().map_err(|err| err.to_string())?;
    ensure_workflow_tables(&mut conn).map_err(|err| err.to_string())?;
    let log_context = apply_operator_test(state_ref, &mut conn, &session_snapshot, &payload)
        .map_err(|err| err.to_string())?;
    persist_operator_test_log(&mut conn, &session_snapshot, &log_context)
        .map_err(|err| err.to_string())?;
    build_production_snapshot(state_ref).map_err(|err| err.to_string())
}

#[tauri::command]
fn get_operator_test_results(
    state: State<AppState>,
    payload: OperatorTestResultsRequest,
) -> Result<Option<TestResultResponse>, String> {
    let state_ref = state.inner();
    let pool = state_ref.app_pool().map_err(|err| err.to_string())?;
    let mut conn = pool.get_conn().map_err(|err| err.to_string())?;

    let identifier = payload.wire;
    let row = conn
        .exec_first::<Row, _, _>(
            "SELECT ow.ref_coil, ow.length_mm, ow.ext1, ow.ext2, wo.of_id, wo.reference \
             FROM order_wires ow \
             JOIN work_orders wo ON ow.work_order_id = wo.id \
             WHERE ow.work_order_id = ? AND ow.ref_wire = ? AND ow.marquage = ?",
            (
                identifier.work_order_id,
                identifier.ref_wire.as_str(),
                identifier.marquage.as_str(),
            ),
        )
        .map_err(|err| err.to_string())?;

    let Some(row) = row else {
        return Ok(None);
    };

    let mut row = row;
    let ref_coil: String = row
        .take::<Option<String>, _>("ref_coil")
        .unwrap_or(None)
        .unwrap_or_default();
    let length_mm: i32 = row.take::<i64, _>("length_mm").unwrap_or(0) as i32;
    let ext1_raw: Option<String> = row.take("ext1");
    let ext2_raw: Option<String> = row.take("ext2");
    let order_of: String = row
        .take::<Option<String>, _>("of_id")
        .unwrap_or(None)
        .unwrap_or_default();

    let ext1: Option<ApiWireExt> =
        ext1_raw.and_then(|value| serde_json::from_str::<ApiWireExt>(&value).ok());
    let ext2: Option<ApiWireExt> =
        ext2_raw.and_then(|value| serde_json::from_str::<ApiWireExt>(&value).ok());

    let spec_left = match ext1.as_ref().and_then(|ext| ext.terminal.as_ref()) {
        Some(terminal) => lookup_crimp_tool_spec(
            state_ref,
            terminal,
            ext1.as_ref().and_then(|ext| ext.joint.as_deref()),
        )
        .map_err(|err| err.to_string())?,
        None => None,
    };
    let spec_right = match ext2.as_ref().and_then(|ext| ext.terminal.as_ref()) {
        Some(terminal) => lookup_crimp_tool_spec(
            state_ref,
            terminal,
            ext2.as_ref().and_then(|ext| ext.joint.as_deref()),
        )
        .map_err(|err| err.to_string())?,
        None => None,
    };

    let references = OperatorReferences {
        strip_left: ext1.as_ref().and_then(|ext| ext.stripping),
        strip_right: ext2.as_ref().and_then(|ext| ext.stripping),
        length: if length_mm > 0 {
            Some(length_mm as f64)
        } else {
            None
        },
        spec_left,
        spec_right,
    };

    let log_row = conn
        .exec_first::<Row, _, _>(
            "SELECT control_crimping_height_left, control_crimping_height_right, \
                    control_traction_force_left, control_traction_force_right, \
                    control_stripping_left, control_stripping_right, control_length, status \
             FROM operator_control_logs \
             WHERE of_id = ? AND ref = ? AND ref_coil = ? \
             ORDER BY created_at DESC LIMIT 1",
            (
                order_of.as_str(),
                identifier.ref_wire.as_str(),
                ref_coil.as_str(),
            ),
        )
        .map_err(|err| err.to_string())?;

    let Some(log_row) = log_row else {
        return Ok(None);
    };

    let mut log_row = log_row;
    let measurements = OperatorMeasurements {
        crimp_left: log_row
            .take::<Option<f64>, _>("control_crimping_height_left")
            .unwrap_or(None),
        crimp_right: log_row
            .take::<Option<f64>, _>("control_crimping_height_right")
            .unwrap_or(None),
        traction_left: log_row
            .take::<Option<f64>, _>("control_traction_force_left")
            .unwrap_or(None),
        traction_right: log_row
            .take::<Option<f64>, _>("control_traction_force_right")
            .unwrap_or(None),
        stripping_left: log_row
            .take::<Option<f64>, _>("control_stripping_left")
            .unwrap_or(None),
        stripping_right: log_row
            .take::<Option<f64>, _>("control_stripping_right")
            .unwrap_or(None),
        length: log_row
            .take::<Option<f64>, _>("control_length")
            .unwrap_or(None),
    };
    let status: Option<String> = log_row.take::<Option<String>, _>("status").unwrap_or(None);

    let result = build_test_result(status, &measurements, &references);
    Ok(Some(result))
}

#[tauri::command]
fn list_history_logs(
    state: State<AppState>,
    payload: HistoryQueryRequest,
) -> Result<HistoryLogPage, String> {
    let state_ref = state.inner();
    let pool = state_ref.app_pool().map_err(|err| err.to_string())?;
    let mut conn = pool.get_conn().map_err(|err| err.to_string())?;
    ensure_workflow_tables(&mut conn).map_err(|err| err.to_string())?;
    ensure_logging_tables(&mut conn).map_err(|err| err.to_string())?;
    query_history_logs(&mut conn, &payload).map_err(|err| err.to_string())
}

#[tauri::command]
fn get_label_printer_settings(
    state: State<AppState>,
) -> Result<printing::LabelPrinterSettingsResponse, String> {
    printing::load_label_printer_settings(state.inner()).map_err(|err| err.to_string())
}

#[tauri::command]
fn save_label_printer_settings(
    state: State<AppState>,
    payload: printing::SaveLabelPrinterSettingsRequest,
) -> Result<printing::LabelPrinterSettingsResponse, String> {
    printing::save_label_printer_settings(state.inner(), payload).map_err(|err| err.to_string())
}

#[tauri::command]
fn list_label_printers() -> Result<Vec<String>, String> {
    printing::list_system_printers().map_err(|err| err.to_string())
}

#[tauri::command]
fn print_bundle_label(
    state: State<AppState>,
    payload: printing::BundleLabelRequest,
) -> Result<printing::BundleLabelResult, String> {
    printing::print_bundle_label(state.inner(), payload).map_err(|err| err.to_string())
}
// -------------------------------------------------------------------------------------------------
// Main entry point
// -------------------------------------------------------------------------------------------------

#[tauri::command]
fn get_feature_flags() -> FeatureFlagsResponse {
    FeatureFlagsResponse {
        crimp_test: env_flag(
            &[
                "ENABLE_CRIMP_TEST",
                "TEST_CRIMP_HEIGHT",
                "VITE_ENABLE_CRIMP_TEST",
                "VITE_TEST_CRIMP_HEIGHT",
            ],
            true,
        ),
        comparator_test: env_flag(&["COMPARATOR_TEST", "VITE_COMPARATOR_TEST"], true),
        microscope_test: env_flag(
            &["ENABLE_MICROSCOPE_TEST", "VITE_ENABLE_MICROSCOPE_TEST"],
            true,
        ),
        label_printing: env_flag(
            &["ENABLE_LABEL_PRINTING", "VITE_ENABLE_LABEL_PRINTING"],
            true,
        ),
    }
}

#[tauri::command]
fn toggle_fullscreen(window: tauri::Window) -> Result<(), String> {
    match window.is_fullscreen() {
        Ok(true) => {
            window.set_fullscreen(false).map_err(|e| e.to_string())?;
            window.maximize().map_err(|e| e.to_string())?;
            Ok(())
        }
        Ok(false) => window.set_fullscreen(true).map_err(|e| e.to_string()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
async fn send_wire_marking(
    state: State<'_, AppState>,
    reference: String,
) -> Result<marker_printing::MarkingPrintResponse, String> {
    let pool = state.app_pool().map_err(|e| e.to_string())?;
    let mut conn = pool.get_conn().map_err(|e| e.to_string())?;
    marker_printing::send_wire_marking(&mut conn, &reference)
        .await
        .map_err(|e| e.to_string())
}

fn main() {
    preload_env();
    if env_debug_enabled() {
        match env::var("USER_LIST_DIR") {
            Ok(value) => println!("Env check: USER_LIST_DIR={value}"),
            Err(_) => println!("Env check: USER_LIST_DIR not detected"),
        }
    }
    match try_cli_login() {
        Ok(Some(response)) => {
            println!(
                "Login succeeded for {} (ID: {}, role: {})",
                response.user_name, response.user_id, response.role
            );
            return;
        }
        Ok(None) => {}
        Err(err) => {
            eprintln!("CLI login failed: {err}");
            std::process::exit(1);
        }
    }
    let state = AppState::new().expect("Failed to initialize application state");

    tauri::Builder::default()
        .manage(state)
        .setup(|app| {
            if let Some(window) = app.get_window("main") {
                let _ = window.set_fullscreen(false);
                let _ = window.maximize();
                let _ = window.show();
            }
            Ok(())
        })
        .on_window_event(|event| match event.event() {
            tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
                if let Some(app_state) = event.window().app_handle().try_state::<AppState>() {
                    cleanup_active_session(app_state.inner());
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            get_dashboard_snapshot,
            validate_wire,
            pause_wire,
            resume_wire,
            stop_wire,
            verify_user_id,
            unlock_wire,
            record_wire_progress,
            finalize_wire_production,
            save_microscope_photo,
            trigger_department_call,
            verify_bundle_label,
            complete_operator_test,
            get_operator_test_results,
            complete_quality_test,
            list_history_logs,
            perform_preflight,
            validate_login,
            fetch_crimp_tool_spec,
            start_session,
            logout,
            get_label_printer_settings,
            save_label_printer_settings,
            list_label_printers,
            print_bundle_label,
            get_feature_flags,
            toggle_fullscreen,
            send_wire_marking,

            camera::save_camera_photo,
            camera::get_microscope_photo
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn init_state() -> Option<AppState> {
        preload_env();

        let user_list = match std::env::var("USER_LIST_DIR") {
            Ok(path) if Path::new(&path).exists() => path,
            _ => return None,
        };

        let shared_folder =
            std::env::var("SHARED_FOLDER").unwrap_or_else(|_| "operator-cache".into());
        std::env::set_var("USER_LIST_DIR", user_list);
        std::env::set_var("SHARED_FOLDER", shared_folder);

        AppState::new().ok()
    }

    #[test]
    fn match_sample_operator_login() {
        let Some(state) = init_state() else {
            eprintln!("Skipping operator login test: USER_LIST_DIR not available");
            return;
        };
        let (csv_path, _) =
            ensure_user_list(&state, "operator").expect("operator csv should be accessible");
        let record = match_user_in_csv(&csv_path, "3", "Abdul")
            .expect("csv scan should succeed")
            .expect("operator Abdul should exist");
        assert_eq!(record.0, "Abdul");
    }

    #[test]
    fn match_sample_admin_login() {
        let Some(state) = init_state() else {
            eprintln!("Skipping admin login test: USER_LIST_DIR not available");
            return;
        };
        let (csv_path, _) =
            ensure_user_list(&state, "admin").expect("admin csv should be accessible");
        let record = match_user_in_csv(&csv_path, "1", "Owad")
            .expect("csv scan should succeed")
            .expect("admin Owad should exist");
        assert_eq!(record.0, "Owad");
    }

    #[test]
    fn microscope_dir_loaded_when_configured() {
        preload_env();
        let config = AppConfig::load();
        if let Some(path) = config.microscope_photo_dir {
            assert!(
                !path.as_os_str().is_empty(),
                "MICROSCOPE_PHOTO_DIR should not be empty"
            );
        } else {
            panic!("MICROSCOPE_PHOTO_DIR not available for tests");
        }
    }
}
