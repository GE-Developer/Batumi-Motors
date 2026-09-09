/*
  The price calculator on a car page.

  All it does is compute numbers and put them into ready-made markup. There is not
  a single word of any language inside it: the captions are already in the HTML,
  translated by the generator, and the script touches only the digits, the dollar
  sign and the percentage. So adding a language does not affect this file.

  Without the script the page still works: the price ladder is visible and the
  button leads to WhatsApp. All that disappears is the hint itself — "what it
  comes to for N days".

  The ladder arrives from the database in the data-steps attribute:
  [[1,65],[2,58],[8,46]] — "from which day" and "price per day". The same format as
  in lib/tariffs.ts, and the same choice of step: the last one whose "from which
  day" is not greater than the term.
*/

document.querySelectorAll(".calc").forEach(function (calc) {
  var steps;
  try {
    steps = JSON.parse(calc.dataset.steps || "[]");
  } catch (e) {
    return; // the ladder did not parse — leave the page as it is
  }
  if (!steps.length) return;

  var daysInput = calc.querySelector(".calc__days");
  var legSelects = [calc.querySelector(".calc__pickup"), calc.querySelector(".calc__return")];
  var rentOut = calc.querySelector(".calc__rent");
  var discountRow = calc.querySelector(".calc__row--discount");
  var discountOut = calc.querySelector(".calc__discount");
  var deliveryRow = calc.querySelector(".calc__row--delivery");
  var deliveryOut = calc.querySelector(".calc__delivery");
  var totalOut = calc.querySelector(".calc__total-value");
  var book = calc.closest(".buy").querySelector(".calc__book");
  // The price list is now a separate block in the neighbouring column rather than
  // a wrapper around the calculator — we look for the steps from a common ancestor.
  var top = calc.closest(".car-top");
  var ladderRows = top ? top.querySelectorAll(".tariffs [data-from]") : [];

  // The ceiling comes from the markup itself (the field's max), so the limit lives
  // in one place rather than two — otherwise somebody changes it in the HTML one
  // day and the script goes on counting the old way.
  var maxDays = Number(daysInput.getAttribute("max")) || 90;

  var start = Number(calc.dataset.start) || 1;
  var basePrice = steps[0][1]; // the first day's price — the discount is measured from it

  function priceForDays(days) {
    var price = steps[0][1];
    for (var i = 0; i < steps.length; i++) if (days >= steps[i][0]) price = steps[i][1];
    return price;
  }

  function update() {
    // An empty field and rubbish must not zero the estimate: while a person is
    // deleting a digit to type another one the field is empty for a moment — we
    // show the default term rather than "$0".
    var days = parseInt(daysInput.value, 10);
    if (!days || days < 1) days = start;
    if (days > maxDays) {
      // We correct the field along with the estimate. It used to correct only the
      // estimate: type "500" and the field kept 500 while the sum was counted for
      // 90 days, so a person saw a suspiciously small number with no explanation.
      days = maxDays;
      daysInput.value = String(maxDays);
    }

    var perDay = priceForDays(days);
    var rent = perDay * days;

    rentOut.textContent = "$" + rent;

    // The discount is how much lower this day's price is than the first day's.
    // Exactly the same quantity as the gain from the ladder, said in percent.
    var off = Math.round((1 - perDay / basePrice) * 100);
    if (off > 0) {
      discountOut.textContent = "−" + off + "%";
      discountRow.hidden = false;
    } else {
      discountRow.hidden = true;
    }

    // Handover and return are counted separately, each at its own price for one
    // leg. An empty value means "another region": this leg does not go into the
    // sum, the manager will quote it. Zero means delivery is free, and there is no
    // point showing "$0".
    var deliverySum = 0;
    legSelects.forEach(function (select) {
      if (select && select.value !== "") deliverySum += Number(select.value);
    });
    if (deliverySum) {
      deliveryOut.textContent = "$" + deliverySum;
      deliveryRow.hidden = false;
    } else {
      deliveryRow.hidden = true;
    }

    totalOut.textContent = "$" + (rent + deliverySum);

    // The term goes to WhatsApp too — the manager sees straight away what this is
    // about, and the client does not have to repeat what they already chose on the
    // page.
    if (book && calc.dataset.phone && calc.dataset.message) {
      var text = calc.dataset.message;
      if (calc.dataset.daysText) text += ". " + calc.dataset.daysText.replace("#", days);
      book.href = "https://wa.me/" + calc.dataset.phone + "?text=" + encodeURIComponent(text);
    }

    // Highlighting the step in force in the price list above the calculator: you
    // see not only what it comes to but why it comes to that.
    ladderRows.forEach(function (row) {
      row.classList.toggle("is-active", Number(row.dataset.from) === activeFrom(days));
    });
  }

  function activeFrom(days) {
    var from = steps[0][0];
    for (var i = 0; i < steps.length; i++) if (days >= steps[i][0]) from = steps[i][0];
    return from;
  }

  daysInput.addEventListener("input", update);
  legSelects.forEach(function (select) {
    if (select) select.addEventListener("change", update);
  });
  update();
});
