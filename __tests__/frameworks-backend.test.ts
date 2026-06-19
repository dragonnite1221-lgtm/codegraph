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

describe('expressResolver.extract', () => {
  it('extracts route with inline handler reference', () => {
    const src = `app.get('/users', listUsers);\n`;
    const { nodes, references } = expressResolver.extract!('routes.ts', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe('GET /users');
    expect(references[0].referenceName).toBe('listUsers');
  });

  it('extracts route with router.post and middleware chain', () => {
    const src = `router.post('/items', auth, createItem);\n`;
    const { nodes, references } = expressResolver.extract!('items.ts', src);
    expect(nodes[0].name).toBe('POST /items');
    // Multiple handlers: prefer the LAST one (convention: middleware first, handler last)
    expect(references[0].referenceName).toBe('createItem');
  });

  it('extracts route with controller method reference', () => {
    const src = `app.get('/x', userController.list);\n`;
    const { nodes, references } = expressResolver.extract!('routes.ts', src);
    expect(references[0].referenceName).toBe('list');
  });
});


describe('laravelResolver.extract', () => {
  it('extracts route with controller tuple syntax', () => {
    const src = `Route::get('/users', [UserController::class, 'index']);\n`;
    const { nodes, references } = laravelResolver.extract!('routes/web.php', src);
    expect(nodes[0].name).toBe('GET /users');
    expect(references[0].referenceName).toBe('index');
  });

  it('extracts route with Controller@action syntax', () => {
    const src = `Route::post('/users', 'UserController@store');\n`;
    const { nodes, references } = laravelResolver.extract!('routes/web.php', src);
    expect(references[0].referenceName).toBe('store');
  });

  it('extracts resource route', () => {
    const src = `Route::resource('users', UserController::class);\n`;
    const { nodes, references } = laravelResolver.extract!('routes/web.php', src);
    expect(nodes[0].kind).toBe('route');
    expect(references[0].referenceName).toBe('UserController');
  });
});


describe('railsResolver.extract', () => {
  it('extracts route with controller#action syntax', () => {
    const src = `get '/users', to: 'users#index'\n`;
    const { nodes, references } = railsResolver.extract!('config/routes.rb', src);
    expect(nodes[0].name).toBe('GET /users');
    expect(references[0].referenceName).toBe('index');
  });

  it('extracts route without to: keyword', () => {
    const src = `post '/items' => 'items#create'\n`;
    const { nodes, references } = railsResolver.extract!('config/routes.rb', src);
    expect(references[0].referenceName).toBe('create');
  });
});


describe('springResolver.extract', () => {
  it('extracts route with @GetMapping and next method', () => {
    const src = `
@GetMapping("/users")
public List<User> listUsers() {
  return users;
}
`;
    const { nodes, references } = springResolver.extract!('UserController.java', src);
    expect(nodes[0].name).toBe('GET /users');
    expect(references[0].referenceName).toBe('listUsers');
  });
});


describe('goResolver.extract', () => {
  it('extracts route from r.GET', () => {
    const src = `r.GET("/users", listUsers)\n`;
    const { nodes, references } = goResolver.extract!('main.go', src);
    expect(nodes[0].name).toBe('GET /users');
    expect(references[0].referenceName).toBe('listUsers');
  });

  it('extracts route from router.HandleFunc', () => {
    const src = `router.HandleFunc("/items", createItem)\n`;
    const { nodes, references } = goResolver.extract!('main.go', src);
    expect(references[0].referenceName).toBe('createItem');
  });
});


describe('rustResolver.extract', () => {
  it('extracts route from axum .route with get()', () => {
    const src = `let app = Router::new().route("/users", get(list_users));\n`;
    const { nodes, references } = rustResolver.extract!('main.rs', src);
    expect(nodes[0].name).toBe('GET /users');
    expect(references[0].referenceName).toBe('list_users');
  });
});

