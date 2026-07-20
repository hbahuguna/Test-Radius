import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trash2, KeyRound, CreditCard, Coins } from "lucide-react";
import { toast } from "sonner";
import {
  getApiKeys,
  saveApiKey,
  deleteApiKey,
  getCreditBalance,
  saveJiraConnection,
  redeemCoupon,
  previewCoupon,
  type UserApiKey,
  type CreditBalance,
  type CouponPreview,
} from "@/lib/agentic-api";

const PROVIDERS = [
  { id: "opencode", label: "Opencode" },
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "google", label: "Google" },
];

export function Settings() {
  const { user, signOut } = useAuth();
  const [keys, setKeys] = useState<UserApiKey[]>([]);
  const [newProvider, setNewProvider] = useState("openai");
  const [newKey, setNewKey] = useState("");
  const [credits, setCredits] = useState<CreditBalance | null>(null);
  const [saving, setSaving] = useState(false);

  const [couponCode, setCouponCode] = useState("");
  const [couponPreview, setCouponPreview] = useState<CouponPreview | null>(null);
  const [couponBusy, setCouponBusy] = useState(false);
  const [couponMsg, setCouponMsg] = useState<string | null>(null);

  const jiraKey = keys.find((k) => k.provider === "jira");
  const [jiraBase, setJiraBase] = useState("");
  const [jiraEmail, setJiraEmail] = useState("");
  const [jiraToken, setJiraToken] = useState("");
  const [jiraSaving, setJiraSaving] = useState(false);
  const [jiraMsg, setJiraMsg] = useState<string | null>(null);

  const handleSaveJira = async () => {
    if (!jiraBase.trim() || !jiraEmail.trim() || !jiraToken.trim()) return;
    setJiraSaving(true);
    setJiraMsg(null);
    try {
      // Remove any existing Jira connection first (one per user).
      if (jiraKey) await deleteApiKey(jiraKey.id);
      await saveJiraConnection({ baseUrl: jiraBase, email: jiraEmail, token: jiraToken });
      setJiraToken("");
      setJiraMsg("Jira connected.");
      load();
    } catch (e: any) {
      setJiraMsg(e?.message || "Failed to connect Jira");
    } finally {
      setJiraSaving(false);
    }
  };

  const load = async () => {
    try {
      const [k, c] = await Promise.all([getApiKeys(), getCreditBalance()]);
      setKeys(k);
      setCredits(c);
    } catch {
      toast.error("Failed to load settings");
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSaveKey = async () => {
    if (!newKey.trim()) return;
    setSaving(true);
    try {
      await saveApiKey(newProvider, newKey.trim());
      setNewKey("");
      toast.success("API key saved");
      load();
    } catch (e: any) {
      toast.error(e?.message || "Failed to save key");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteKey = async (id: number) => {
    try {
      await deleteApiKey(id);
      toast.success("Key removed");
      load();
    } catch {
      toast.error("Failed to delete key");
    }
  };

  const handlePreviewCoupon = async () => {
    const code = couponCode.trim().toUpperCase();
    if (!code) return;
    setCouponBusy(true);
    setCouponMsg(null);
    setCouponPreview(null);
    try {
      const p = await previewCoupon(code);
      setCouponPreview(p);
    } catch (e: any) {
      setCouponMsg(e?.message || "That coupon code does not exist.");
    } finally {
      setCouponBusy(false);
    }
  };

  const handleRedeemCoupon = async () => {
    const code = couponCode.trim().toUpperCase();
    if (!code) return;
    setCouponBusy(true);
    setCouponMsg(null);
    try {
      const { credits_granted } = await redeemCoupon(code);
      toast.success(`Redeemed! +${credits_granted} credits added.`);
      setCouponCode("");
      setCouponPreview(null);
      load();
    } catch (e: any) {
      setCouponMsg(e?.message || "Failed to redeem coupon.");
    } finally {
      setCouponBusy(false);
    }
  };

  const handleBuyCredits = async (priceId: string) => {
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceId }),
      });
      if (!res.ok) throw new Error("Checkout failed");
      const { url } = await res.json();
      if (url) window.location.href = url;
    } catch (e: any) {
      toast.error(e?.message || "Could not start checkout");
    }
  };

  return (
    <div className="min-h-[100dvh] w-full bg-background text-foreground pt-24 px-6 pb-16">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold">Settings</h1>
          <Button variant="outline" size="sm" onClick={() => signOut()}>
            Sign out
          </Button>
        </div>

        {credits && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Coins className="h-5 w-5" /> Plan & Credits
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3">
                <Badge variant="secondary" className="capitalize">{credits.plan}</Badge>
                <span className="text-sm text-muted-foreground">
                  {credits.credits_remaining} credits remaining · {credits.credits_used} used
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => handleBuyCredits("price_credit_pack_10")}>
                  Buy 10 credits ($5)
                </Button>
                <Button size="sm" onClick={() => handleBuyCredits("price_credit_pack_50")}>
                  Buy 50 credits ($20)
                </Button>
                <Button size="sm" onClick={() => handleBuyCredits("price_credit_pack_200")}>
                  Buy 200 credits ($60)
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Coins className="h-5 w-5" /> Redeem a Coupon
            </CardTitle>
            <CardDescription>
              Have a promo code? Enter it to add credits to your account.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1.5">
                <Label>Coupon code</Label>
                <Input
                  placeholder="e.g. LAUNCH20"
                  value={couponCode}
                  onChange={(e) => {
                    setCouponCode(e.target.value);
                    setCouponPreview(null);
                    setCouponMsg(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRedeemCoupon();
                  }}
                />
              </div>
              <Button variant="outline" onClick={handlePreviewCoupon} disabled={couponBusy || !couponCode.trim()}>
                Check
              </Button>
              <Button onClick={handleRedeemCoupon} disabled={couponBusy || !couponCode.trim()}>
                Redeem
              </Button>
            </div>
            {couponPreview && !couponPreview.expired && (
              <p className="text-sm text-muted-foreground">
                This code grants <span className="font-medium text-foreground">{couponPreview.credits} credits</span>
                {couponPreview.description ? ` — ${couponPreview.description}` : ""}.
              </p>
            )}
            {couponPreview?.expired && (
              <p className="text-sm text-destructive">This coupon code has expired.</p>
            )}
            {couponMsg && <p className="text-sm text-destructive">{couponMsg}</p>}
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5" /> API Keys (BYOK)
            </CardTitle>
            <CardDescription>
              Bring your own provider keys. Each run still uses 1 TestRadius credit.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              {keys.length === 0 && (
                <p className="text-sm text-muted-foreground">No API keys saved yet.</p>
              )}
              {keys.map((k) => (
                <div key={k.id} className="flex items-center justify-between border rounded-md p-3">
                  <div>
                    <span className="font-medium capitalize">{k.provider}</span>
                    <span className="text-muted-foreground text-sm ml-2">••••{k.keyHint}</span>
                  </div>
                  <Button variant="ghost" size="icon" onClick={() => handleDeleteKey(k.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>

            <div className="flex items-end gap-2 pt-2 border-t">
              <div className="flex-1 space-y-1.5">
                <Label>Provider</Label>
                <Select value={newProvider} onValueChange={setNewProvider}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDERS.map((p) => (
                      <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex-1 space-y-1.5">
                <Label>API Key</Label>
                <Input
                  type="password"
                  placeholder="sk-..."
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                />
              </div>
              <Button onClick={handleSaveKey} disabled={saving || !newKey.trim()}>
                Save
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="mb-6 rounded-xl border-border shadow-lg">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5" /> Jira Connection
            </CardTitle>
            <CardDescription>
              Connect your Jira instance to import tickets as test goals in the Agentic Tester.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {jiraKey ? (
              <div className="flex items-center justify-between border rounded-md p-3">
                <div>
                  <span className="font-medium">Connected</span>
                  <span className="text-muted-foreground text-sm ml-2">{jiraKey.keyHint}</span>
                </div>
                <Button variant="ghost" size="icon" onClick={() => handleDeleteKey(jiraKey.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No Jira instance connected yet.</p>
            )}
            <div className="grid sm:grid-cols-3 gap-3 pt-2 border-t">
              <div className="space-y-1.5">
                <Label>Jira Base URL</Label>
                <Input
                  placeholder="https://your-domain.atlassian.net"
                  value={jiraBase}
                  onChange={(e) => setJiraBase(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Email</Label>
                <Input
                  type="email"
                  placeholder="you@company.com"
                  value={jiraEmail}
                  onChange={(e) => setJiraEmail(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>API Token</Label>
                <Input
                  type="password"
                  placeholder="••••"
                  value={jiraToken}
                  onChange={(e) => setJiraToken(e.target.value)}
                />
              </div>
            </div>
            {jiraMsg && (
              <p className={`text-sm ${jiraMsg.includes("connected") ? "text-green-600" : "text-destructive"}`}>
                {jiraMsg}
              </p>
            )}
            <Button onClick={handleSaveJira} disabled={jiraSaving || !jiraBase.trim() || !jiraEmail.trim() || !jiraToken.trim()}>
              {jiraSaving ? "Connecting…" : jiraKey ? "Update Connection" : "Connect Jira"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CreditCard className="h-5 w-5" /> Billing
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => handleBuyCredits("price_pro_monthly")}>
              Manage Subscription (Pro — 500 credits/mo)
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
