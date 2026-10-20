// What animates runs only while it can be seen, as T3 Code's visibleAnimation
// does: a session at work in a row scrolled out of the sidebar, or the
// compacting line above the conversation's fold, is held still and costs
// nothing; back in view, it runs on (imperfect.css holds it). Until the first
// look it runs, so a row drawn in view does not start a beat late. A node
// taken out of the page is let go.
let observer = null;
export function animateInView(element) {
  if (!element || typeof IntersectionObserver === 'undefined') return element;
  observer ??= new IntersectionObserver(entries => {
    for (const { target, isIntersecting } of entries) {
      if (!target.isConnected) { observer.unobserve(target); continue; }
      target.toggleAttribute('data-out-of-view', !isIntersecting);
    }
  });
  observer.observe(element);
  return element;
}
