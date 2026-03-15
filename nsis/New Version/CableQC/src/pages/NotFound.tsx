import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Compass } from "lucide-react";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-br from-background via-background to-primary/10 p-6">
      <div className="absolute inset-x-0 top-0 -z-10 h-[320px] bg-gradient-to-b from-primary/20 via-primary/10 to-transparent blur-3xl" />
      <div className="absolute -bottom-24 -right-24 -z-10 h-[320px] w-[320px] rounded-full bg-secondary/20 blur-3xl" />
      <div className="absolute -top-24 -left-24 -z-10 h-[280px] w-[280px] rounded-full bg-primary/20 blur-3xl" />

      <Card className="max-w-xl border border-border/50 bg-card/80 shadow-2xl backdrop-blur">
        <CardContent className="space-y-6 p-10">
          <Badge variant="secondary" className="gap-2 border border-primary/20 bg-primary/10 text-primary">
            <Compass className="h-4 w-4" />
            Navigation glitch
          </Badge>

          <div className="space-y-2">
            <h1 className="text-4xl font-semibold text-foreground">Page not found</h1>
            <p className="text-base text-muted-foreground">
              The CableQC System view you were looking for doesn’t exist—or no longer lives at this route. Let’s guide
              you back to the live console.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button asChild className="gap-2">
              <Link to="/dashboard">
                <ArrowLeft className="h-4 w-4" />
                Return to dashboard
              </Link>
            </Button>
            <Button asChild variant="outline" className="gap-2 border-border/60 bg-background/70 backdrop-blur">
              <Link to="/login">Switch account</Link>
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            Error code: <span className="font-medium text-foreground">404</span> — {location.pathname}
          </p>
        </CardContent>
      </Card>
    </div>
  );
};

export default NotFound;
