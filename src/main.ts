#!/usr/bin/env node
import { createProgram } from "./index.js";

await createProgram().parseAsync();
