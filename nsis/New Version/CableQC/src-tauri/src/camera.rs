use tauri::State;
use std::fs;
use chrono::Local;
use base64::{Engine as _, engine::general_purpose};
use crate::AppState; 

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")] // Automagically converts "refWire" (TS) to "ref_wire" (Rust)
pub struct CameraPhotoRequest {
    pub image_data: String,
    pub of_id: String,
    pub reference: String,
    pub ref_wire: String,     // Added this
    pub marquage: String,     // Added this
    pub orientation: String,  // Added this
    pub side: String,         // Added this
    pub machine_id: Option<String>,      // Optional
    pub operator_id: Option<String>,     // Optional
    pub quality_agent_id: Option<String> // Optional
}

#[tauri::command]
pub fn save_camera_photo(
    state: State<AppState>, 
    payload: CameraPhotoRequest
) -> Result<String, String> {
    
    // DEBUG LOG: Look at your terminal when you click save!
    println!("RUST: Received photo request for OF: {}", payload.of_id);

    // 1. Get Config
    let config_guard = state.config.read().map_err(|_| "Failed to acquire config lock")?;
    
    let save_dir = config_guard.microscope_photo_dir.clone()
        .ok_or("Microscope photo directory not configured")?;

    drop(config_guard); // Release lock

    // 2. Check Directory
    if !save_dir.exists() {
        let err_msg = format!("Shared Folder not found at: {:?}", save_dir);
        println!("RUST ERROR: {}", err_msg); // Print to terminal
        return Err(err_msg);
    }

    // 3. Generate Filename (DD-MM-YYYY_HH-mm-ss.jpg)
    let now = Local::now();
    let filename = format!("{}.jpg", now.format("%d-%m-%Y_%H-%M-%S"));
    let file_path = save_dir.join(&filename);

    // 4. Decode Base64
    let base64_string = payload.image_data.split(',').last().unwrap_or(&payload.image_data);
    
    let image_bytes = match general_purpose::STANDARD.decode(base64_string) {
        Ok(bytes) => bytes,
        Err(e) => {
            println!("RUST ERROR: Base64 decode failed: {}", e);
            return Err(format!("Invalid Image Data: {}", e));
        }
    };

    // 5. Write to disk
    match fs::write(&file_path, image_bytes) {
        Ok(_) => println!("RUST: File saved successfully at {:?}", file_path),
        Err(e) => {
            println!("RUST ERROR: Write failed: {}", e);
            return Err(format!("Could not write file: {}", e));
        }
    }

    // 6. Return the full path
    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn get_microscope_photo(
    state: State<AppState>,
    path: String
) -> Result<String, String> {
    let path = std::path::PathBuf::from(path);

    // Security: Ensure the file is within the configured microscope directory
    let config_guard = state.config.read().map_err(|_| "Failed to acquire config lock")?;
    let allowed_dir = config_guard.microscope_photo_dir.clone()
        .ok_or("Microscope photo directory not configured")?;
    drop(config_guard);

    if !path.starts_with(&allowed_dir) {
        return Err("Access denied: File outside microscope directory".to_string());
    }

    if !path.exists() {
        return Err("File not found".to_string());
    }

    let bytes = fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    let base64_string = general_purpose::STANDARD.encode(bytes);
    
    // Determine mime type (simplified)
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("jpg").to_lowercase();
    let mime = match extension.as_str() {
        "png" => "image/png",
        "gif" => "image/gif",
        _ => "image/jpeg",
    };

    Ok(format!("data:{};base64,{}", mime, base64_string))
}
