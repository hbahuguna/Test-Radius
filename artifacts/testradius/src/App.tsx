import React from "react";
import { Route, Switch } from "wouter";
import { Home } from "./pages/Home";
import { BlogIndex } from "./pages/BlogIndex";
import { BlogPost } from "./pages/BlogPost";
import { Careers } from "./pages/Careers";

function App() {
  return (
    <Switch>
      <Route path="/">
        <Home />
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
      {/* Add a 404 Not Found route if desired */}
      <Route>
        <center>404: Not Found</center>
      </Route>
    </Switch>
  );
}

export default App;
