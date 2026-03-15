use crate::AppError;
use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;
use tokio::io::{AsyncWriteExt, AsyncReadExt};
use tokio::sync::Mutex;
use std::sync::Arc;
use once_cell::sync::Lazy;

// Printer Configuration
const PRINTER_IP: &str = "192.168.200.111";
const PRINTER_PORT: u16 = 3028;
const CONNECTION_TIMEOUT_SECS: u64 = 5;
const RESPONSE_BUFFER_SIZE: usize = 3028;

// Global persistent connection
static PRINTER_CONNECTION: Lazy<Arc<Mutex<Option<TcpStream>>>> = 
    Lazy::new(|| Arc::new(Mutex::new(None)));

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MarkingPrintResponse {
    pub success: bool,
    pub message: String,
}

/// Établit ou récupère la connexion persistante à l'imprimante
async fn get_or_create_connection() -> Result<Arc<Mutex<Option<TcpStream>>>, AppError> {
    let mut conn_guard = PRINTER_CONNECTION.lock().await;
    
    // Vérifier si la connexion existe et est valide
    if conn_guard.is_some() {
        println!("[MARKER] Utilisation de la connexion existante");
        return Ok(PRINTER_CONNECTION.clone());
    }

    // Créer une nouvelle connexion
    println!("[MARKER] Établissement de la connexion persistante à l'imprimante {}:{}", PRINTER_IP, PRINTER_PORT);

    let connect_timeout = tokio::time::timeout(
        std::time::Duration::from_secs(CONNECTION_TIMEOUT_SECS),
        TcpStream::connect((PRINTER_IP, PRINTER_PORT))
    );

    match connect_timeout.await {
        Ok(Ok(stream)) => {
            println!("[MARKER] Connexion persistante établie avec succès");
            *conn_guard = Some(stream);
            Ok(PRINTER_CONNECTION.clone())
        }
        Ok(Err(e)) => {
            let msg = format!("Échec de la connexion à l'imprimante: {}", e);
            eprintln!("[MARKER] {}", msg);
            Err(AppError::Network(msg))
        }
        Err(_) => {
            let msg = format!(
                "Timeout de connexion à l'imprimante après {} secondes",
                CONNECTION_TIMEOUT_SECS
            );
            eprintln!("[MARKER] {}", msg);
            Err(AppError::Network(msg))
        }
    }
}

/// Récupère le texte de marquage du fil et l'envoie à l'imprimante
/// Utilise ref_wire comme identifiant pour trouver le marquage dans la base de données
pub async fn send_wire_marking(
    conn: &mut mysql::PooledConn,
    reference: &str,
) -> Result<MarkingPrintResponse, AppError> {
    use mysql::prelude::Queryable;

    if reference.trim().is_empty() {
        return Err(AppError::Network(
            "La référence ne peut pas être vide".to_string(),
        ));
    }

    // Récupérer le texte de marquage depuis la base de données
    // Chercher dans la table order_wires le marquage correspondant à la référence
    let marking_text: Option<String> = conn
        .exec_first(
            "SELECT marquage FROM order_wires WHERE ref_wire = ? LIMIT 1",
            (reference.trim(),),
        )
        .map_err(|e| AppError::Mysql(e))?;

    let marking_text = marking_text.ok_or_else(|| {
        AppError::Network(format!("Aucun texte de marquage trouvé pour la référence: {}", reference))
    })?;

    send_marking_to_printer(&marking_text).await
}

/// Envoie un texte de marquage à l'imprimante via la connexion persistante
pub async fn send_marking_to_printer(marking_text: &str) -> Result<MarkingPrintResponse, AppError> {
    if marking_text.trim().is_empty() {
        return Err(AppError::Network("Le texte de marquage ne peut pas être vide".to_string()));
    }

    // Obtenir ou créer la connexion persistante
    let conn = get_or_create_connection().await?;
    let mut conn_guard = conn.lock().await;

    let stream = conn_guard.as_mut().ok_or_else(|| {
        AppError::Network("Impossible d'obtenir une connexion à l'imprimante".to_string())
    })?;

    // Construire la commande TSPL
    let cmd = format!("MD {}\r", marking_text.trim());
    println!("[MARKER] Envoi de la commande: {}", cmd.trim());

    // Envoyer la commande via la connexion persistante
    if let Err(e) = stream.write_all(cmd.as_bytes()).await {
        let msg = format!("Erreur lors de l'envoi au marqueur: {}", e);
        eprintln!("[MARKER] {}", msg);
        // Fermer la connexion en cas d'erreur pour forcer une reconnexion
        drop(conn_guard);
        let mut new_guard = conn.lock().await;
        *new_guard = None;
        return Err(AppError::Network(msg));
    }

    // Forcer l'envoi des données
    if let Err(e) = stream.flush().await {
        let msg = format!("Erreur lors du flush des données: {}", e);
        eprintln!("[MARKER] {}", msg);
        drop(conn_guard);
        let mut new_guard = conn.lock().await;
        *new_guard = None;
        return Err(AppError::Network(msg));
    }

    println!("[MARKER] Commande envoyée, attente de la réponse de l'imprimante...");

    // Attendre la réponse de l'imprimante avec timeout (DISABLED FOR TESTING - Citonix CI5500 ne retourne pas de réponse)
    let mut buffer = vec![0u8; RESPONSE_BUFFER_SIZE];
    let read_timeout = tokio::time::timeout(
        std::time::Duration::from_secs(CONNECTION_TIMEOUT_SECS),
        stream.read(&mut buffer)
    );

    let response = match read_timeout.await {
        Ok(Ok(n)) => {
            if n > 0 {
                String::from_utf8_lossy(&buffer[..n]).to_string()
            } else {
                "[TESTING MODE] Aucune réponse reçue - Mode test activé".to_string()
            }
        }
        Ok(Err(e)) => {
            println!("[MARKER] Erreur lors de la lecture de la réponse (attendu en mode test): {}", e);
            "[TESTING MODE] Pas de réponse - Mode test activé".to_string()
        }
        Err(_) => {
            println!("[MARKER] Timeout - Pas de réponse reçue (attendu avec Citonix CI5500)");
            "[TESTING MODE] Timeout réponse - Mode test activé".to_string()
        }
    };

    println!("[MARKER] Réponse reçue: {}", response.trim());

    // La connexion reste ouverte pour les prochains messages
    drop(conn_guard);

    // EN MODE TEST: Accepter le succès même sans réponse de l'imprimante
    // Car l'imprimante Citonix CI5500 n'envoie pas de réponse confirmant le marquage
    println!("[MARKER] Marquage appliqué avec succès (mode test - vérification réponse désactivée)");
    Ok(MarkingPrintResponse {
        success: true,
        message: format!("Marquage appliqué à l'imprimante avec succès. [TEST MODE - Pas de réponse de l'imprimante Citonix CI5500]"),
    })
}

/// Ferme la connexion persistante à l'imprimante
pub async fn close_printer_connection() -> Result<(), AppError> {
    let mut conn_guard = PRINTER_CONNECTION.lock().await;
    if conn_guard.is_some() {
        println!("[MARKER] Fermeture de la connexion persistante");
        if let Some(mut stream) = conn_guard.take() {
            let _ = stream.shutdown().await;
        }
    }
    Ok(())
}
