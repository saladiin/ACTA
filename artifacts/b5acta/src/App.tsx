import { useEffect, useRef } from "react";
import { ClerkProvider, useClerk, useAuth } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { Switch, Route, useLocation, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { setExtraHeaders } from "@workspace/api-client-react";

import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

import Home from "@/pages/home";
import SignInPage from "@/pages/sign-in";
import SignUpPage from "@/pages/sign-up";
import Lobby from "@/pages/lobby";
import Fleets from "@/pages/fleets";
import NewGame from "@/pages/new-game";
import GameBoard from "@/pages/game-board";
import GamesList from "@/pages/games";
import Settings from "@/pages/settings";
import NotFound from "@/pages/not-found";
import { DevModeToggle } from "@/components/dev-mode-toggle";
import { getDevUserId } from "@/lib/dev-user";
import { getTemporaryUserId, temporaryUsernameAuthEnabled, useTemporaryUsername } from "@/lib/temporary-user";

// `refetchOnWindowFocus` disabled globally: while the dice-roll modal is
// open we deliberately hold off invalidating the game query so the board
// doesn't reveal damage before the player rolls. A background tab-focus
// refetch would silently bypass that gate and leak the result, so we
// opt-out and rely on explicit invalidations after each player action.
const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

const configuredClerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const clerkProxyUrl = clerkPubKey.startsWith("pk_test_") || temporaryUsernameAuthEnabled ? undefined : configuredClerkProxyUrl;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in .env file");
}

if (temporaryUsernameAuthEnabled) {
  const tempUserId = getTemporaryUserId();
  setExtraHeaders(tempUserId ? { "x-dev-user-id": tempUserId } : null);
} else if (import.meta.env.DEV) {
  setExtraHeaders({ "x-dev-user-id": getDevUserId() });
}

const clerkLocalization = {
  signIn: {
    start: {
      title: "Access B5: ACTA",
      subtitle: "Commander, authenticate to resume operations",
    },
  },
  signUp: {
    start: {
      title: "Enlist in B5: ACTA",
      subtitle: "Register your command to deploy fleets",
    },
  },
};

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "hsl(43 96% 58%)",
    colorForeground: "hsl(0 0% 98%)",
    colorMutedForeground: "hsl(240 5% 65%)",
    colorDanger: "hsl(0 84% 60%)",
    colorBackground: "hsl(240 10% 6%)",
    colorInput: "hsl(240 10% 16%)",
    colorInputForeground: "hsl(0 0% 98%)",
    colorNeutral: "hsl(240 10% 16%)",
    fontFamily: "Inter, sans-serif",
    borderRadius: "0.25rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-card rounded-md border border-border w-[440px] max-w-full overflow-hidden",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-foreground",
    headerSubtitle: "text-muted-foreground",
    socialButtonsBlockButtonText: "text-foreground",
    formFieldLabel: "text-foreground",
    footerActionLink: "text-primary hover:text-primary/90",
    footerActionText: "text-muted-foreground",
    dividerText: "text-muted-foreground",
    identityPreviewEditButton: "text-primary",
    formFieldSuccessText: "text-green-500",
    alertText: "text-destructive-foreground",
    logoBox: "flex justify-center",
    logoImage: "w-16 h-16",
    socialButtonsBlockButton: "border-border text-foreground hover:bg-secondary",
    formButtonPrimary: "bg-primary text-primary-foreground hover:bg-primary/90",
    formFieldInput: "bg-input text-foreground border-border focus:border-ring",
    footerAction: "bg-transparent",
    dividerLine: "bg-border",
    alert: "bg-destructive border-destructive",
    otpCodeFieldInput: "border-border",
    formFieldRow: "mb-4",
    main: "w-full",
  },
};

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

function HomeRedirect() {
  return <Redirect to="/lobby" />;
}

function ProtectedRoute({ component: Component }: { component: any }) {
  const temporaryUsername = useTemporaryUsername();
  if (temporaryUsernameAuthEnabled) {
    return temporaryUsername ? <Component /> : <Redirect to="/sign-in" />;
  }
  if (import.meta.env.DEV) return <Component />;
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return null;
  if (!isSignedIn) return <Redirect to="/sign-in" />;
  return <Component />;
}

function TemporaryUsernameHeaders() {
  const temporaryUsername = useTemporaryUsername();
  useEffect(() => {
    if (!temporaryUsernameAuthEnabled) return;
    const tempUserId = getTemporaryUserId();
    setExtraHeaders(tempUserId ? { "x-dev-user-id": tempUserId } : null);
    queryClient.clear();
  }, [temporaryUsername]);
  return null;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      localization={clerkLocalization}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ClerkQueryClientCacheInvalidator />
          <TemporaryUsernameHeaders />
          <Switch>
            <Route path="/" component={HomeRedirect} />
            <Route path="/sign-in/*?" component={SignInPage} />
            <Route path="/sign-up/*?" component={SignUpPage} />
            <Route path="/lobby"><ProtectedRoute component={Lobby} /></Route>
            <Route path="/fleets"><ProtectedRoute component={Fleets} /></Route>
            <Route path="/games/new"><ProtectedRoute component={NewGame} /></Route>
            <Route path="/games/:id"><ProtectedRoute component={GameBoard} /></Route>
            <Route path="/games"><ProtectedRoute component={GamesList} /></Route>
            <Route path="/settings"><ProtectedRoute component={Settings} /></Route>
            <Route component={NotFound} />
          </Switch>
          <Toaster />
          <DevModeToggle />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
