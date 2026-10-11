import PropTypes from 'prop-types';

export function Badge({ tone, children }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
Badge.propTypes = { tone: PropTypes.oneOf(['info', 'warn']), children: PropTypes.node };
Badge.defaultProps = { tone: 'info' };
