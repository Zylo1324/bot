import test from 'node:test';
import assert from 'node:assert/strict';

import { section } from '../lib/markdown.js';

test('formatea una sección con viñetas', () => {
  const result = section('Opciones de ChatGPT Plus', ['Compartida — S/10', 'Completa — S/20 (incluye Canva)']);
  assert.equal(
    result,
    '*Opciones de ChatGPT Plus*\n• Compartida — S/10\n• Completa — S/20 (incluye Canva)'
  );
});

test('omite elementos vacíos y espacios extra', () => {
  const result = section('Beneficios', ['  Soporte 24/7  ', '', ' Activación inmediata\n']);
  assert.equal(result, '*Beneficios*\n• Soporte 24/7\n• Activación inmediata');
});

test('convierte valores no string a texto', () => {
  const result = section('Incluye', ['Perfiles', 2, true]);
  assert.equal(result, '*Incluye*\n• Perfiles\n• 2\n• true');
});

test('cuando no hay elementos devuelve solo el título', () => {
  const result = section('Resumen', []);
  assert.equal(result, '*Resumen*');
});

test('lanza si el título está vacío', () => {
  assert.throws(() => section('   ', ['item']), TypeError);
});
