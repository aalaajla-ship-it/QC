import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Globe, Layers, PlugZap, ShieldCheck, Sparkles } from "lucide-react";

export default function Settings() {
  return (
    <div className="flex flex-1 flex-col gap-4 bg-gradient-to-br from-background to-muted/20 p-4 sm:p-6">
      <header className="flex flex-row items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-foreground sm:text-xl">Settings</h1>
          <p className="text-sm text-muted-foreground">Configure application preferences and system parameters</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="text-sm">
            Reset
          </Button>
          <Button size="sm" className="text-sm">Save</Button>
        </div>
      </header>

      <section className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Card className="border border-border/40 bg-card/80 backdrop-blur">
          <CardHeader className="border-b border-border/30">
            <CardTitle className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-primary" />
              <span className="text-base font-semibold text-foreground">Appearance</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 pt-6">
            <div className="flex items-center justify-between rounded-lg border border-border/40 bg-background/70 p-3">
              <Label className="text-xs font-medium text-foreground">Theme</Label>
              <Select defaultValue="system">
                <SelectTrigger className="h-8 w-32 rounded-lg text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="dark">Dark</SelectItem>
                  <SelectItem value="system">System</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border/40 bg-background/70 p-3">
              <Label className="text-xs font-medium text-foreground">Table density</Label>
              <Select defaultValue="normal">
                <SelectTrigger className="h-8 w-32 rounded-lg text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="compact">Compact</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="comfortable">Comfortable</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border/40 bg-background/70 p-3">
              <Label className="text-xs font-medium text-foreground">Animations</Label>
              <Switch defaultChecked />
            </div>
          </CardContent>
        </Card>

        <Card className="border border-border/40 bg-card/80 backdrop-blur">
          <CardHeader className="border-b border-border/30">
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" />
              <span className="text-base font-semibold text-foreground">Compliance</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-6 text-xs text-muted-foreground">
            <p>• Settings sync across terminals</p>
            <p>• Session timeouts enforced network-wide</p>
            <p>• Changes mirrored in backend config</p>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card className="border border-border/40 bg-card/80 backdrop-blur">
          <CardHeader className="border-b border-border/30">
            <CardTitle className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-primary" />
              <span className="text-base font-semibold text-foreground">Network</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 pt-6">
            <div className="space-y-1.5">
              <Label htmlFor="master-host" className="text-xs font-medium">Master host</Label>
              <Input id="master-host" defaultValue="192.168.1.100" className="h-9 rounded-lg text-sm" />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="shared-folder" className="text-xs font-medium">Shared folder</Label>
              <Input id="shared-folder" defaultValue="\\server\\crimpflow\\shared" className="h-9 rounded-lg text-sm" />
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border/40 bg-background/70 p-3">
              <Label className="text-xs font-medium text-foreground">Auto-reconnect</Label>
              <Switch defaultChecked />
            </div>
          </CardContent>
        </Card>

        <Card className="border border-border/40 bg-card/80 backdrop-blur">
          <CardHeader className="border-b border-border/30">
            <CardTitle className="flex items-center gap-2">
              <PlugZap className="h-4 w-4 text-primary" />
              <span className="text-base font-semibold text-foreground">Session</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 pt-6">
            <div className="flex items-center justify-between rounded-lg border border-border/40 bg-background/70 p-3">
              <Label className="text-xs font-medium text-foreground">Unique sessions</Label>
              <Switch defaultChecked />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-lg border border-border/40 bg-background/70 p-3">
              <Label htmlFor="idle-timeout" className="text-xs font-medium text-foreground">
                Auto-logout (min)
              </Label>
              <Input id="idle-timeout" type="number" className="h-9 w-20 rounded-lg text-sm" defaultValue={30} />
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border/40 bg-background/70 p-3">
              <Label className="text-xs font-medium text-foreground">Audit logging</Label>
              <Switch />
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
