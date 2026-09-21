/**
 * Admin page behaviour: colour pickers kept in step with their text fields,
 * and a confirmation on anything destructive.
 *
 * No framework. The page works without this file — the colour text inputs are
 * editable on their own and the forms submit normally; this only makes them
 * pleasanter.
 */
(function () {
  'use strict';

  // Each colour setting has a native picker beside a hex text field. Typing in
  // one updates the other, so an operator can paste a brand hex or pick.
  document.querySelectorAll('[data-colour-for]').forEach(function (picker) {
    var text = document.getElementById(picker.getAttribute('data-colour-for'));
    if (!text) return;

    picker.addEventListener('input', function () {
      text.value = picker.value;
    });

    text.addEventListener('input', function () {
      if (/^#[0-9a-fA-F]{6}$/.test(text.value.trim())) {
        picker.value = text.value.trim();
      }
    });
  });

  // Removing a paid request refunds it; skipping interrupts a room. Both are
  // worth a moment's pause.
  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-confirm]');
    if (!button) return;
    if (!window.confirm(button.getAttribute('data-confirm'))) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
})();
