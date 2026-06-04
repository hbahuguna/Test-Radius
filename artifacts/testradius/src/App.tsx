import React from "react";
import { Route, Switch } from "wouter";
import { Home } from "./pages/Home";
import { BlogIndex } from "./pages/BlogIndex";
import { BlogPost } from "./pages/BlogPost";
import { Careers } from "./pages/Careers";
import { DocsPage } from "./pages/DocsPage";

function App() {
  return (
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
      <Route path="/jobs">
        <Careers />
      </Route>
      <Route path="/careers">
        <Careers />
      </Route>
      <Route>
        <center>404: Not Found</center>
      </Route>
    </Switch>
  );
}

export default App;
