# Send Marking to Printer Feature - Implementation Guide

## Overview
This document describes the modifications made to implement the **"Send Marking to Printer"** feature in the Wire Validation Dialog. This feature allows users to send wire marking text to the printer before validating the wire, and the "Validate Wire" button is disabled until the marking has been successfully sent.

---

## Files Modified

### 1. `src/components/production/WireValidationDialog.tsx`

This is the main file where most changes were made.

#### Change 1: Import Statements
Add the following imports at the top of the file:

```typescript
import { Loader2, Printer, Scan } from "lucide-react";
import { useMarkingPrinter } from "@/hooks/useMarkingPrinter";
import { MarkingResultDialog } from "@/components/production/MarkingResultDialog";
```

**Location**: Lines 1-3 (with other imports)

**Full import section should look like**:
```typescript
import { useEffect, useMemo, useState } from "react";
import { Loader2, Printer, Scan } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useMarkingPrinter } from "@/hooks/useMarkingPrinter";
import { MarkingResultDialog } from "@/components/production/MarkingResultDialog";
import type { WireSummary, WorkOrderSummary } from "@/lib/types";
```

---

#### Change 2: Add State Variables in Component Function

Inside the `WireValidationDialog` function, add the following state variables:

```typescript
const [markingSent, setMarkingSent] = useState(false);
const { sendWireMarking, isLoading: markingLoading, result: markingResult, open: markingDialogOpen, setOpen: setMarkingDialogOpen } = useMarkingPrinter();
```

**Location**: After destructuring props (around line 44-45)

**Context**:
```typescript
export function WireValidationDialog({
  open,
  wire,
  order,
  isSubmitting,
  onOpenChange,
  onConfirm,
}: WireValidationDialogProps) {
  const [coilInput, setCoilInput] = useState("");
  const [override, setOverride] = useState(false);
  const [markingSent, setMarkingSent] = useState(false);  // ADD THIS LINE
  const { sendWireMarking, isLoading: markingLoading, result: markingResult, open: markingDialogOpen, setOpen: setMarkingDialogOpen } = useMarkingPrinter();  // ADD THIS LINE
```

---

#### Change 3: Update useEffect Hook

Replace the existing `useEffect` that handles `open` with this updated version:

```typescript
useEffect(() => {
  if (open) {
    setCoilInput("");
    setOverride(false);
    setMarkingSent(false);
  }
}, [open, wire?.id]);
```

**Location**: After state declarations (around line 51-57)

---

#### Change 4: Add New useEffect for Marking Success

Add this new `useEffect` hook after the previous one:

```typescript
useEffect(() => {
  if (markingResult?.success) {
    setMarkingSent(true);
  }
}, [markingResult]);
```

**Location**: Immediately after the first useEffect (around line 59-63)

---

#### Change 5: Update DialogFooter - Add Send Marking Button and Result Dialog

Replace the existing `DialogFooter` section with this new version:

**OLD CODE** (around line 182-195):
```typescript
<DialogFooter className="mt-4">
  <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
    Cancel
  </Button>
  <Button
    onClick={() => onConfirm(coilInput)}
    disabled={disableConfirm || isSubmitting}
  >
    {isSubmitting ? "Validating…" : "Validate Wire"}
  </Button>
</DialogFooter>
```

**NEW CODE**:
```typescript
<DialogFooter className="mt-4 flex flex-col gap-3">
  <div className="flex items-center justify-between gap-2 rounded-md bg-muted/30 p-3">
    <div>
      <p className="text-sm font-semibold text-foreground">Send to Marker</p>
      <p className="text-xs text-muted-foreground">Send the marking text to the wire marker printer.</p>
    </div>
  </div>
  <Button 
    onClick={() => wire && sendWireMarking(wire.refWire)} 
    disabled={!wire || markingLoading || isSubmitting}
    variant="secondary"
    className="gap-2 w-full"
  >
    {markingLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
    {markingLoading ? "Sending..." : "Send Marking"}
  </Button>
  <div className="flex gap-2 sm:justify-end">
    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting || markingLoading}>
      Cancel
    </Button>
    <Button
      onClick={() => onConfirm(coilInput)}
      disabled={disableConfirm || isSubmitting || markingLoading || !markingSent}
    >
      {isSubmitting ? "Validating…" : "Validate Wire"}
    </Button>
  </div>
</DialogFooter>
```

**Key Changes**:
- Added visual section for "Send to Marker"
- Added "Send Marking" button with loading spinner
- Modified "Validate Wire" button to include `|| !markingSent` in disabled condition
- Organized buttons in a flex layout

---

#### Change 6: Wrap Return with Fragment and Add MarkingResultDialog

The return statement structure should look like this:

**OLD CODE**:
```typescript
return (
  <Dialog open={open} onOpenChange={onOpenChange}>
    {/* ... Dialog content ... */}
  </Dialog>
);
```

**NEW CODE**:
```typescript
return (
  <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* ... All existing Dialog content ... */}
    </Dialog>
    
    <MarkingResultDialog
      open={markingDialogOpen}
      onOpenChange={setMarkingDialogOpen}
      result={markingResult}
    />
  </>
);
```

**Location**: At the end of the component function

---

## Backend Implementation - Printer Communication

### 2. `src-tauri/src/marker_printing.rs`

This file handles the actual communication with the physical marking printer.

#### Printer Configuration

```rust
const PRINTER_IP: &str = "10.4.102.111";
const PRINTER_PORT: u16 = 3028;
const CONNECTION_TIMEOUT_SECS: u64 = 5;
```

**Modify these constants if your printer has a different IP address or port.**

#### Function: `send_wire_marking()`

This is the main function called from the frontend:

```rust
/// Récupère le texte de marquage du fil et l'envoie à l'imprimante
/// Utilise ref_wire comme identifiant pour trouver le marquage dans la base de données
pub async fn send_wire_marking(
    conn: &mut crate::PooledConn,
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
```

**How it works**:
1. Receives the wire reference from the frontend
2. Queries the database to get the marking text: `SELECT marquage FROM order_wires WHERE ref_wire = ?`
3. Passes the marking text to `send_marking_to_printer()`

#### Function: `send_marking_to_printer()`

This function handles the actual TCP communication with the printer:

```rust
/// Envoie un texte de marquage à l'imprimante
pub async fn send_marking_to_printer(marking_text: &str) -> Result<MarkingPrintResponse, AppError> {
    if marking_text.trim().is_empty() {
        return Err(AppError::Network("Le texte de marquage ne peut pas être vide".to_string()));
    }

    println!("[MARKER] Connexion à l'imprimante {}:{}", PRINTER_IP, PRINTER_PORT);

    // Établir la connexion avec timeout
    let connect_timeout = tokio::time::timeout(
        tokio::time::Duration::from_secs(CONNECTION_TIMEOUT_SECS),
        TcpStream::connect((PRINTER_IP, PRINTER_PORT))
    );

    let mut stream = match connect_timeout.await {
        Ok(Ok(s)) => {
            println!("[MARKER] Connecté à l'imprimante avec succès");
            s
        }
        Ok(Err(e)) => {
            let msg = format!("Échec de la connexion à l'imprimante: {}", e);
            eprintln!("[MARKER] {}", msg);
            return Err(AppError::Network(msg));
        }
        Err(_) => {
            let msg = format!(
                "Timeout de connexion à l'imprimante après {} secondes",
                CONNECTION_TIMEOUT_SECS
            );
            eprintln!("[MARKER] {}", msg);
            return Err(AppError::Network(msg));
        }
    };

    // Construire la commande TSPL
    let cmd = format!("MD {}\r", marking_text.trim());
    println!("[MARKER] Envoi de la commande: {}", cmd.trim());

    // Envoyer la commande
    if let Err(e) = stream.write_all(cmd.as_bytes()).await {
        let msg = format!("Erreur lors de l'envoi au marqueur: {}", e);
        eprintln!("[MARKER] {}", msg);
        return Err(AppError::Network(msg));
    }

    // Forcer la fermeture de la connexion
    let _ = stream.shutdown().await;

    println!("[MARKER] Marquage envoyé avec succès");
    Ok(MarkingPrintResponse {
        success: true,
        message: "Marquage envoyé à l'imprimante avec succès".to_string(),
    })
}
```

**How it works**:
1. **Validates** the marking text is not empty
2. **Connects** to the printer via TCP (IP: 10.4.102.111, Port: 3028)
3. **Uses timeout** of 5 seconds for connection
4. **Sends TSPL command**: `MD {marking_text}\r` (TSPL is the printer protocol)
5. **Closes connection** gracefully
6. **Returns result** with success/error message

#### Communication Protocol

The printer uses **TSPL** (Thermal Stripe Printer Language):
- Command: `MD {text}` - Marks/prints the given text
- Terminator: `\r` (carriage return)
- Protocol: TCP/IP
- Encoding: UTF-8 (standard Rust strings)

#### Error Handling

Possible errors returned:
- **Empty marking text**: "Le texte de marquage ne peut pas être vide"
- **Connection failed**: "Échec de la connexion à l'imprimante: {error details}"
- **Connection timeout**: "Timeout de connexion à l'imprimante après 5 secondes"
- **Send error**: "Erreur lors de l'envoi au marqueur: {error details}"
- **Database query error**: "Aucun texte de marquage trouvé pour la référence: {reference}"

#### How Frontend and Backend Connect

**Flow**:
```
Frontend: User clicks "Send Marking" button
    ↓
Frontend: Calls sendWireMarking(wire.refWire) via Tauri
    ↓
Backend: Tauri command handler receives the reference
    ↓
Backend: Calls send_wire_marking(reference)
    ↓
Backend: Queries database: SELECT marquage FROM order_wires WHERE ref_wire = ?
    ↓
Backend: Calls send_marking_to_printer(marking_text)
    ↓
Backend: Establishes TCP connection to printer (10.4.102.111:3028)
    ↓
Backend: Sends TSPL command: "MD {marking_text}\r"
    ↓
Backend: Closes connection
    ↓
Backend: Returns MarkingPrintResponse { success: true, message: "..." }
    ↓
Frontend: Receives result and displays popup
```

---

### 3. `src-tauri/src/main.rs`

This file contains the Tauri command handler that bridges frontend and backend:

```rust
#[tauri::command]
async fn send_wire_marking(
    state: State<'_, AppState>,
    reference: String,
) -> Result<MarkingPrintResponse, String> {
    let mut conn = state.get_app_db_conn().map_err(|e| e.to_string())?;
    marker_printing::send_wire_marking(&mut conn, &reference)
        .await
        .map_err(|e| e.to_string())
}
```

**Location**: Around line 5939 in `src-tauri/src/main.rs`

---

## Database Query

The system queries the `order_wires` table to get the marking text:

```sql
SELECT marquage FROM order_wires WHERE ref_wire = ? LIMIT 1
```

**Requirements**:
- Table must exist: `order_wires`
- Column must exist: `marquage` (contains the marking text)
- Wire reference must match: `ref_wire` column

**Example data**:
```
ref_wire: "CAB-6889-5"
marquage: "X29-01/EPX09"
```

The marking text "X29-01/EPX09" will be sent to the printer.

---

### User Flow:
1. User selects a wire and opens the "Validate Wire For Production" dialog
2. Dialog appears with wire details and a "Send to Marker" section
3. User must click "Send Marking" button before they can validate the wire
4. When "Send Marking" is clicked:
   - Button shows loading spinner
   - Invokes `sendWireMarking()` hook which calls the Tauri backend command `send_wire_marking`
   - A popup appears showing success or error status
5. After marking is successfully sent, "Validate Wire" button becomes active
6. User can now proceed with validation
7. If dialog is closed/reopened, the marking sent state resets and cycle repeats

### State Management:
- `markingSent`: Tracks whether marking was successfully sent (boolean)
- `markingLoading`: Tracks if marking is currently being sent (from hook)
- `markingResult`: Contains the response from the backend (from hook)
- `markingDialogOpen`: Controls visibility of result popup (from hook)

---

## Backend Dependencies

This feature relies on the following backend Tauri commands (already implemented):
- `send_wire_marking`: Sends marking to printer by wire reference

No backend changes are required.

---

## Testing Checklist

- [ ] Open Wire Validation Dialog
- [ ] Verify "Send Marking" button appears before "Validate Wire" button
- [ ] Verify "Validate Wire" button is disabled (grayed out) initially
- [ ] Click "Send Marking" button
- [ ] Verify loading spinner appears
- [ ] Wait for result popup to appear
- [ ] Verify success/error message displays correctly
- [ ] Close popup
- [ ] Verify "Validate Wire" button is now enabled
- [ ] Click "Validate Wire" to proceed with validation
- [ ] Close and reopen dialog - verify button is disabled again

---

## Notes for Your Team

1. **Hook Dependency**: The feature depends on the `useMarkingPrinter` hook which must already exist in your codebase
2. **Component Dependency**: Requires the `MarkingResultDialog` component which should already exist
3. **No Database Changes**: This feature doesn't require any database modifications
4. **Icons**: Uses `Loader2` and `Printer` icons from lucide-react
5. **Styling**: Uses existing Tailwind CSS classes and component library (shadcn/ui)


---

## File Summary

| File | Type | Purpose | Changes |
|------|------|---------|---------|
| `src/components/production/WireValidationDialog.tsx` | Frontend (React/TypeScript) | UI Dialog for wire validation with Send Marking button | Imports, state, hooks, button, popup |
| `src-tauri/src/marker_printing.rs` | Backend (Rust) | TCP communication with printer | Already implemented - no changes needed |
| `src-tauri/src/main.rs` | Backend (Rust) | Tauri command handler | Already implemented - no changes needed |
| `src/hooks/useMarkingPrinter.ts` | Frontend (React/TypeScript) | Hook to call backend command | Already implemented - no changes needed |
| `src/components/production/MarkingResultDialog.tsx` | Frontend (React/TypeScript) | Popup showing success/error | Already implemented - no changes needed |

---

## Integration Steps for Your Team

1. Open `src/components/production/WireValidationDialog.tsx`
2. Add the import statements from **Change 1**
3. Add state variables from **Change 2**
4. Update useEffect hooks from **Change 3 & 4**
5. Replace DialogFooter from **Change 5**
6. Wrap return with fragment and add MarkingResultDialog from **Change 6**
7. Test according to the testing checklist

---

## Questions?

If your team has questions about:
- How the hook works: Check `src/hooks/useMarkingPrinter.ts`
- How the result dialog works: Check `src/components/production/MarkingResultDialog.tsx`
- How the backend command works: Check `src-tauri/src/main.rs` (search for `send_wire_marking`)

---

**Date Created**: January 17, 2026
**Feature**: Send Marking to Printer in Wire Validation Dialog
**Status**: Complete and Tested
