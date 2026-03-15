import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button"; // Adjust path if your UI components are elsewhere

interface CameraCaptureProps {
    label: string;
    onCapture: (base64Data: string) => void;
}

export function CameraCapture({ label, onCapture }: CameraCaptureProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [stream, setStream] = useState<MediaStream | null>(null);
    const [error, setError] = useState<string>("");
    const [capturedImage, setCapturedImage] = useState<string | null>(null);

    // Start camera automatically when component loads
    useEffect(() => {
        startCamera();
        return () => stopCamera(); // Cleanup when leaving
    }, []);

    // Re-bind stream to video element whenever it is remounted (e.g. after Retake)
    useEffect(() => {
        if (stream && videoRef.current && !capturedImage) {
            videoRef.current.srcObject = stream;
        }
    }, [stream, capturedImage]);

    async function startCamera() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            // Look for the microscope or default to any video input
            const microscope = devices.find(d =>
                d.label.includes("GENERAL WEBCAM") || d.label.includes("Microscope")
            );

            const constraints = {
                video: {
                    deviceId: microscope ? { exact: microscope.deviceId } : undefined,
                    // You can adjust resolution here if needed
                    width: { ideal: 1920 },
                    height: { ideal: 1080 }
                }
            };

            const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
            setStream(mediaStream);
            if (videoRef.current) {
                videoRef.current.srcObject = mediaStream;
            }
            setError("");
        } catch (err) {
            console.error(err);
            setError("Camera not found. Please check connection.");
        }
    }

    function stopCamera() {
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
            setStream(null);
        }
    }

    function takePhoto() {
        if (!videoRef.current) return;

        // Create a canvas to draw the video frame
        const canvas = document.createElement("canvas");
        canvas.width = videoRef.current.videoWidth;
        canvas.height = videoRef.current.videoHeight;
        const ctx = canvas.getContext("2d");

        if (ctx) {
            ctx.drawImage(videoRef.current, 0, 0);
            // Convert to Base64 String
            const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
            setCapturedImage(dataUrl);
            // We don't stop the camera yet, just hide the video and show the image
        }
    }

    function handleRetake() {
        setCapturedImage(null);
        // Video is still running in background, just show it again
    }

    function handleConfirm() {
        if (capturedImage) {
            onCapture(capturedImage);
        }
    }

    return (
        <div className="border p-4 rounded-md bg-slate-50 mb-4">
            <h3 className="font-semibold mb-2 text-lg">{label}</h3>

            {error && <div className="text-red-600 bg-red-100 p-2 rounded mb-2">{error}</div>}

            <div className="flex flex-col gap-3">
                {!capturedImage ? (
                    /* LIVE VIDEO MODE */
                    <>
                        <div className="relative aspect-video bg-black rounded overflow-hidden shadow-sm">
                            <video
                                ref={videoRef}
                                autoPlay
                                playsInline
                                className="w-full h-full object-contain"
                            />
                        </div>
                        <Button onClick={takePhoto} size="lg" className="w-full">
                            Capture Photo
                        </Button>
                    </>
                ) : (
                    /* PREVIEW MODE */
                    <>
                        <div className="relative aspect-video bg-black rounded overflow-hidden shadow-sm">
                            <img
                                src={capturedImage}
                                alt="Captured"
                                className="w-full h-full object-contain"
                            />
                        </div>
                        <div className="flex gap-2">
                            <Button variant="outline" onClick={handleRetake} className="flex-1">
                                Retake
                            </Button>
                            <Button onClick={handleConfirm} className="flex-1 bg-green-600 hover:bg-green-700">
                                Confirm & Save
                            </Button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}