import React from "react";
import { Redirect, Route, Switch } from "wouter";
import { Home } from "./pages/Home";
import { BlogIndex } from "./pages/BlogIndex";
import { BlogPost } from "./pages/BlogPost";
import { Careers } from "./pages/Careers";
import { Pricing } from "./pages/Pricing";
import { DocsPage } from "./pages/DocsPage";
import { Login } from "./pages/Login";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { Tester } from "./pages/Tester";
import { BrowserAuto } from "./pages/BrowserAuto";
import { Settings } from "./pages/Settings";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { StagehandAgent } from "./pages/StagehandAgent";
import { BrowserAgent } from "./pages/BrowserAgent";
import { QueryFirst } from "./pages/QueryFirst";

function App() {
  return (
    <ErrorBoundary>
    <Switch>
      <Route path="/">
        <Home />
      </Route>
      <Route path="/docs/architecture">
        <DocsPage slug="architecture" />
      </Route>
      <Route path="/docs/troubleshooting">
        <DocsPage slug="troubleshooting" />
      </Route>
      <Route path="/docs/usage/:page">
        {(params) => <DocsPage slug={`usage/${params.page}`} />}
      </Route>
      <Route path="/docs/deploy/:page">
        {(params) => <DocsPage slug={`deploy/${params.page}`} />}
      </Route>
      <Route path="/docs/develop/:page">
        {(params) => <DocsPage slug={`develop/${params.page}`} />}
      </Route>
      <Route path="/docs">
        <DocsPage slug="" />
      </Route>
      <Route path="/blog">
        <BlogIndex />
      </Route>
      <Route path="/blog/:slug">
        <BlogPost />
      </Route>
      <Route path="/pricing">
        <Pricing />
      </Route>
      <Route path="/jobs">
        <Careers />
      </Route>
      <Route path="/careers">
        <Careers />
      </Route>
      <Route path="/login">
        <Login />
      </Route>
      <Route path="/tester">
        <ProtectedRoute>
          <Tester />
        </ProtectedRoute>
      </Route>
      <Route path="/browser-auto">
        <ProtectedRoute>
          <BrowserAuto />
        </ProtectedRoute>
      </Route>
      <Route path="/browser-agent">
        <ProtectedRoute>
          <BrowserAgent />
        </ProtectedRoute>
      </Route>
      <Route path="/queryfirst">
        <ProtectedRoute>
          <QueryFirst />
        </ProtectedRoute>
      </Route>
      <Route path="/stagehand-agent">
        <ProtectedRoute>
          <StagehandAgent />
        </ProtectedRoute>
      </Route>
      <Route path="/settings">
        <ProtectedRoute>
          <Settings />
        </ProtectedRoute>
      </Route>
      <Route>
        <center>404: Not Found</center>
      </Route>
    </Switch>
    </ErrorBoundary>
  );
}

export default App;
