import { describe, it, expect } from 'vitest';
import type { FrameworkResolver, UnresolvedRef } from '../src/resolution/types';
import type { Node } from '../src/types';
import { getApplicableFrameworks } from '../src/resolution/frameworks';
import { djangoResolver, flaskResolver, fastapiResolver } from '../src/resolution/frameworks/python';
import { expressResolver } from '../src/resolution/frameworks/express';
import { laravelResolver } from '../src/resolution/frameworks/laravel';
import { railsResolver } from '../src/resolution/frameworks/ruby';
import { springResolver } from '../src/resolution/frameworks/java';
import { goResolver } from '../src/resolution/frameworks/go';
import { rustResolver } from '../src/resolution/frameworks/rust';
import { aspnetResolver } from '../src/resolution/frameworks/csharp';
import { vaporResolver } from '../src/resolution/frameworks/swift';
import { reactResolver } from '../src/resolution/frameworks/react';
import { svelteResolver } from '../src/resolution/frameworks/svelte';

describe('aspnetResolver.extract', () => {
  it('extracts route from [HttpGet] attribute', () => {
    const src = `
[HttpGet("/users")]
public IActionResult ListUsers()
{
  return Ok();
}
`;
    const { nodes, references } = aspnetResolver.extract!('UserController.cs', src);
    expect(nodes[0].name).toBe('GET /users');
    expect(references[0].referenceName).toBe('ListUsers');
  });
});


describe('vaporResolver.extract', () => {
  it('extracts route from app.get with use:', () => {
    const src = `app.get("users", use: listUsers)\n`;
    const { nodes, references } = vaporResolver.extract!('routes.swift', src);
    expect(nodes[0].name).toBe('GET users');
    expect(references[0].referenceName).toBe('listUsers');
  });
});


describe('reactResolver.extract (smoke)', () => {
  it('returns { nodes, references } shape', () => {
    const src = `<Route path="/users" element={<UsersPage/>}/>`;
    const result = reactResolver.extract!('App.tsx', src);
    expect(result).toHaveProperty('nodes');
    expect(result).toHaveProperty('references');
    expect(Array.isArray(result.nodes)).toBe(true);
    expect(Array.isArray(result.references)).toBe(true);
  });
});

describe('svelteResolver.extract (smoke)', () => {
  it('returns { nodes, references } shape', () => {
    const result = svelteResolver.extract!('+page.svelte', '');
    expect(result).toHaveProperty('nodes');
    expect(result).toHaveProperty('references');
  });
});
