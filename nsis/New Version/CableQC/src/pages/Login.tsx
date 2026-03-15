import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Shield, User } from "lucide-react";
import { validateLogin } from "@/lib/api";
import { useAppFlow } from "@/context/AppFlowContext";

export default function Login() {
  const navigate = useNavigate();
  const { setCredentials } = useAppFlow();

  const [role, setRole] = useState<"admin" | "operator">("operator");
  const [userId, setUserId] = useState("");
  const [userName, setUserName] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("app:login-ready"));
    }, 120);
    return () => {
      window.clearTimeout(timer);
    };
  }, []);

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!userId.trim()) {
      toast.error("Please enter your user ID");
      return;
    }
    if (!userName.trim()) {
      toast.error("Please enter your full name");
      return;
    }

    setLoading(true);
    try {
      const response = await validateLogin({
        userId: userId.trim(),
        userName: userName.trim(),
        role,
      });
      setCredentials(response);
      toast.success(`Welcome ${response.userName}!`);
      navigate("/startup");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to validate credentials.";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-br from-background to-muted/20 p-4 sm:p-6">
      <div className="w-full max-w-md">
        <Card className="border border-border/40 bg-card/90 shadow-xl backdrop-blur">
          <CardHeader className="border-b border-border/30">
            <CardTitle className="text-lg font-semibold text-foreground">Sign In</CardTitle>
            <CardDescription className="text-xs text-muted-foreground">
              Select your role and enter your credentials to access the system
            </CardDescription>
          </CardHeader>

          <CardContent className="pt-6">
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-foreground">Role</Label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setRole("operator")}
                    className={`group flex flex-col items-center gap-1.5 rounded-lg border-2 p-3 transition ${
                      role === "operator"
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/40 hover:bg-primary/5"
                    }`}
                  >
                    <User
                      className={`h-5 w-5 transition ${
                        role === "operator" ? "text-primary" : "text-muted-foreground group-hover:text-primary"
                      }`}
                    />
                    <span className="text-xs font-medium text-foreground">User</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setRole("admin")}
                    className={`group flex flex-col items-center gap-1.5 rounded-lg border-2 p-3 transition ${
                      role === "admin"
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/40 hover:bg-primary/5"
                    }`}
                  >
                    <Shield
                      className={`h-5 w-5 transition ${
                        role === "admin" ? "text-primary" : "text-muted-foreground group-hover:text-primary"
                      }`}
                    />
                    <span className="text-xs font-medium text-foreground">Admin</span>
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="userId" className="text-xs font-medium">User ID</Label>
                <Input
                  id="userId"
                  placeholder="Scan badge or enter ID"
                  autoComplete="username"
                  value={userId}
                  onChange={(event) => setUserId(event.target.value)}
                  className="h-9 rounded-lg text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="userName" className="text-xs font-medium">Full Name</Label>
                <Input
                  id="userName"
                  placeholder="Enter your full name"
                  autoComplete="name"
                  value={userName}
                  onChange={(event) => setUserName(event.target.value)}
                  className="h-9 rounded-lg text-sm"
                />
              </div>

              <Button type="submit" className="w-full h-9 text-sm" disabled={loading}>
                {loading ? "Verifying…" : "Sign In"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
