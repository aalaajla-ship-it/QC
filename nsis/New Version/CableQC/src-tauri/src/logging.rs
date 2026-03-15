use crate::AppError;
use chrono::Local;
use once_cell::sync::Lazy;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

#[derive(Clone, Debug)]
struct LogFiles {
    app: PathBuf,
    error: PathBuf,
}

static LOG_FILES: Lazy<RwLock<Option<LogFiles>>> = Lazy::new(|| RwLock::new(None));

fn touch(path: &Path) -> Result<(), AppError> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    OpenOptions::new().create(true).append(true).open(path)?;
    Ok(())
}

pub fn configure(base_dir: PathBuf, app_log: PathBuf, error_log: PathBuf) -> Result<(), AppError> {
    fs::create_dir_all(&base_dir)?;
    touch(&app_log)?;
    touch(&error_log)?;

    let mut guard = LOG_FILES.write().expect("log files lock poisoned");
    *guard = Some(LogFiles {
        app: app_log,
        error: error_log,
    });
    Ok(())
}

fn write_line(path: &Path, level: &str, message: &str) -> Result<(), AppError> {
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S");
    writeln!(file, "{} {}: {}", timestamp, level, message)?;
    Ok(())
}

pub fn log_info(message: &str) {
    log_internal("INFO", message, false);
}

pub fn log_warn(message: &str) {
    log_internal("WARN", message, false);
}

pub fn log_error(message: &str) {
    log_internal("ERROR", message, true);
}

fn log_internal(level: &str, message: &str, is_error: bool) {
    let guard = LOG_FILES.read().expect("log files lock poisoned");
    let Some(files) = guard.as_ref() else {
        return;
    };
    if let Err(err) = write_line(&files.app, level, message) {
        eprintln!("logging failure: {err}");
    }
    if is_error {
        if let Err(err) = write_line(&files.error, level, message) {
            eprintln!("logging failure: {err}");
        }
    }
}
